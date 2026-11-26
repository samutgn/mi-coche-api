// Fiesta ST Garaje — servidor (Cloudflare Worker)
// Configuración en wrangler.jsonc (base de datos DB, variable SOURCE, cron cada minuto).
// Secret APP_KEY: contraseña de la app.
// SOURCE = "mock" (coche simulado) o "ford" (coche real).

const SCHEMA = '3';
let TANK_L = 45;                 // depósito (Fiesta ST Mk8: 45 L); se cambia en Ajustes → Tu coche
const LIVE_MIN_INTERVAL_S = 30;  // con Ford real: no consultar más a menudo
const GAP_PARKED_S = 300;        // registro del histórico aparcado
const GAP_DRIVING_S = 60;        // registro del histórico en marcha
const POINT_GAP_S = 15;          // puntos del recorrido
const UNLOCKED_GRACE_S = 480;    // margen antes de avisar de coche abierto (da tiempo a las comprobaciones tras aparcar)
const PARK_CHECKS_S = [180, 360]; // tras apagar, se le pide el estado al coche a los 3 y 6 min para ver si lo has cerrado
const TYRE_MIN = 2.2, BATT_MIN = 12.2, FUEL_MIN = 12, OIL_WARM = 80;
const FUEL_API = 'https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/FiltroProvincia/';
const FUEL_FIELDS = { '95': 'Precio Gasolina 95 E5', '98': 'Precio Gasolina 98 E5' };
const PUSH_SUBJECT = 'https://garaje-coche-app.github.io/app/';
// Circuitos conocidos: centro del recinto y radio en km (o rectángulo "box" para la Nordschleife).
// approx: ubicación sacada de la dirección, no de coordenadas publicadas.
const CIRCUITS = [
  { id: 'albacete', name: 'Circuito de Albacete', lat: 39.00782, lon: -1.79590, r: 1.0 },
  { id: 'motorland', name: 'MotorLand Aragón', lat: 41.0755, lon: -0.1980, r: 1.9 },
  { id: 'jarama', name: 'Circuito del Jarama', lat: 40.61711, lon: -3.58558, r: 0.9 },
  { id: 'montmelo', name: 'Circuit de Barcelona-Catalunya', lat: 41.5700, lon: 2.2611, r: 1.5 },
  { id: 'cheste', name: 'Circuit Ricardo Tormo (Cheste)', lat: 39.48583, lon: -0.62806, r: 1.2 },
  { id: 'navarra', name: 'Circuito de Navarra', lat: 42.56106, lon: -2.16361, r: 1.3 },
  { id: 'jerez', name: 'Circuito de Jerez', lat: 36.70833, lon: -6.03417, r: 1.3 },
  { id: 'almeria', name: 'Circuito de Almería', lat: 37.0899, lon: -2.2719, r: 2.0 },
  { id: 'guadix', name: 'Circuito de Guadix', lat: 37.40167, lon: -3.07472, r: 1.2 },
  { id: 'monteblanco', name: 'Circuito Monteblanco', lat: 37.35917, lon: -6.56565, r: 1.5 },
  { id: 'calafat', name: 'Circuit de Calafat', lat: 40.93389, lon: 0.84167, r: 1.0 },
  { id: 'cartagena', name: 'Circuito de Cartagena', lat: 37.64556, lon: -1.03626, r: 1.0 },
  { id: 'parcmotor', name: 'Parcmotor Castellolí', lat: 41.5902, lon: 1.69077, r: 1.3 },
  { id: 'ascari', name: 'Ascari Race Resort', lat: 36.82556, lon: -5.08361, r: 1.5 },
  { id: 'alcarras', name: "Circuit d'Alcarràs", lat: 41.575, lon: 0.500, r: 3.5, approx: true },
  { id: 'kotarr', name: 'Circuito Kotarr', lat: 41.800, lon: -3.570, r: 3.0, approx: true },
  { id: 'mallorca', name: 'Circuit Mallorca (Llucmajor)', lat: 39.505, lon: 2.850, r: 3.5, approx: true },
  // Nürburgring: GP-Strecke por radio y Nordschleife por rectángulo (el lazo de 20,8 km)
  { id: 'nring-gp', group: 'nring', name: 'Nürburgring GP-Strecke', lat: 50.3330, lon: 6.9440, r: 1.1 },
  { id: 'nring-nords', group: 'nring', name: 'Nürburgring Nordschleife', box: [50.336, 6.905, 50.388, 7.022] }
];
let CUSTOM_CIRCUITS = []; // añadidos desde la app ("Guardar este circuito"), se cargan en prepare()
function inCircuit(c, loc) {
  if (c.box) return loc.lat >= c.box[0] && loc.lat <= c.box[2] && loc.lon >= c.box[1] && loc.lon <= c.box[3];
  return distKm(loc.lat, loc.lon, c.lat, c.lon) <= c.r;
}
function circuitAt(loc) {
  if (!loc || loc.lat == null) return null;
  return [...CUSTOM_CIRCUITS, ...CIRCUITS].find(c => inCircuit(c, loc)) || null;
}
// Nombre final de una sesión según las zonas recorridas (variantes del Nürburgring)
function sessionName(zones, fallback) {
  const z = new Set(zones || []);
  if (z.has('nring-gp') && z.has('nring-nords')) return 'Nürburgring 24h (GP + Nordschleife)';
  if (z.has('nring-nords')) return 'Nürburgring Nordschleife';
  if (z.has('nring-gp')) return 'Nürburgring GP-Strecke';
  return fallback;
}
const CIRCUIT_MIN_SHARE = 0.5; // para etiquetar un trayecto como circuito, al menos la mitad de los puntos dentro
const TYRE_NAMES = { fl: 'delantera izquierda', fr: 'delantera derecha', rl: 'trasera izquierda', rr: 'trasera derecha' };
const DEFAULT_MAINT = [
  ['Aceite y filtro', 15000, 12],
  ['Revisión oficial Ford', 20000, 12],
  ['Revisar pastillas delanteras', 10000, null],
  ['Filtro de aire', 30000, 24],
  ['Líquido de frenos', null, 24]
];

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    if (!env.APP_KEY) return json({ error: 'Falta el secret APP_KEY en el Worker' }, 500);
    // Siri (app Atajos): la contraseña puede ir en la dirección y siempre contesta con una frase, aunque falle
    if (new URL(req.url).pathname === '/api/siri') {
      const u = new URL(req.url);
      const say = (t, st = 200) => new Response(t, { status: st, headers: { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' } });
      if ((req.headers.get('x-app-key') || u.searchParams.get('k')) !== env.APP_KEY) return say('La contraseña del atajo no es correcta. Vuelve a copiar la dirección desde los ajustes de la app.');
      try { await prepare(env); return say(await siriText(env)); }
      catch (e) { console.error('siri', e); return say('Ahora mismo no puedo leer el coche: ' + String(e.message || e)); }
    }
    if (req.headers.get('x-app-key') !== env.APP_KEY) return json({ error: 'Contraseña incorrecta' }, 401);
    const url = new URL(req.url);
    const p = url.pathname, m = req.method;
    let mt;
    try {
      await prepare(env);
      if (m === 'GET' && p === '/api/live') return json(await getLive(env, ctx));
      if (m === 'GET' && p === '/api/history') return json(await getHistory(env, clampInt(url.searchParams.get('days'), 1, 365, 7)));
      if (m === 'GET' && p === '/api/battery') return json(await getBattery(env, clampInt(url.searchParams.get('days'), 3, 90, 14)));
      if (m === 'GET' && p === '/api/refuels') return json(await getRefuels(env));
      if (m === 'POST' && (mt = p.match(/^\/api\/refuels\/(\d+)$/))) return json(await updateRefuel(env, +mt[1], await req.json()));
      if (m === 'POST' && p === '/api/pump/read') return json(await readPump(env, await req.json()));
      if (m === 'POST' && p === '/api/pump/save') return json(await savePump(env, await req.json()));
      if (m === 'GET' && (mt = p.match(/^\/api\/refuels\/(\d+)\/photo$/))) return pumpPhoto(env, +mt[1]);
      if (m === 'POST' && p === '/api/ford/connect') return json(await fordConnect(env, await req.json()));
      if (m === 'POST' && p === '/api/ford/refresh') return json(await fordRefresh(env));
      if (m === 'GET' && p === '/api/ford/status') return json(await fordStatus(env));
      if (m === 'GET' && p === '/api/circuits') return json(await circuitStats(env));
      if (m === 'POST' && p === '/api/circuits/custom') return json(await addCustomCircuit(env, await req.json()));
      if (m === 'DELETE' && p.startsWith('/api/circuits/custom/')) return json(await delCustomCircuit(env, decodeURIComponent(p.slice(21))));
      if (m === 'GET' && p === '/api/track') return json(await getTrack(env));
      if (m === 'POST' && p === '/api/track') return json(await setTrack(env, await req.json()));
      if (m === 'GET' && p === '/api/tyreset') return json(await getTyreSet(env));
      if (m === 'POST' && p === '/api/tyreset') return json(await setTyreSet(env, await req.json()));
      if (m === 'GET' && p === '/api/trackdays') return json(await trackDays(env));
      if (m === 'POST' && p === '/api/trackdays/note') return json(await setTrackNote(env, await req.json()));
      if (m === 'GET' && p === '/api/deadlines') return json(await listDeadlines(env));
      if (m === 'POST' && p === '/api/deadlines') return json(await saveDeadline(env, await req.json()));
      if (m === 'DELETE' && p.startsWith('/api/deadlines/')) return json(await deleteDeadline(env, decodeURIComponent(p.slice(15))));
      if (m === 'GET' && p === '/api/widget') return json(await widget(env));
      if (m === 'GET' && p === '/api/fuel/advice') return json(await refuelAdvice(env));
      if (m === 'GET' && p === '/api/engine') return json(await engineStats(env, clampInt(url.searchParams.get('days'), 7, 365, 30)));
      if (m === 'GET' && p === '/api/trackprep') return json(await trackPrep(env));
      if (m === 'GET' && p === '/api/car-config') return json(await carConfig(env));
      if (m === 'POST' && p === '/api/car-config') return json(await setCarConfig(env, await req.json()));
      if (m === 'GET' && p === '/api/month') return json(await monthSummary(env, url.searchParams.get('m')));
      if (m === 'GET' && p === '/api/backups') return json(await listBackups(env));
      if (m === 'GET' && p.startsWith('/api/backups/')) return json(await getBackup(env, decodeURIComponent(p.slice(13))));
      if (m === 'GET' && p === '/api/expenses') return json(await listExpenses(env, url.searchParams.get('year')));
      if (m === 'POST' && p === '/api/expenses') return json(await saveExpense(env, await req.json()));
      if (m === 'GET' && p === '/api/places') return json({ places: await getPlaces(env) });
      if (m === 'POST' && p === '/api/places') return json(await savePlace(env, await req.json()));
      if (m === 'GET' && p === '/api/tyres') return json(await getTyrePrefs(env));
      if (m === 'POST' && p === '/api/tyres') return json(await setTyrePrefs(env, await req.json()));
      if (m === 'GET' && p === '/api/guard') return json(await getGuard(env));
      if (m === 'POST' && p === '/api/guard') return json(await setGuard(env, await req.json()));
      if (m === 'GET' && p === '/api/parking') return json(await getParking(env));
      if (m === 'POST' && p === '/api/parking') return json(await setParking(env, await req.json()));
      if (m === 'GET' && p === '/api/export') return json(await exportAll(env));
      if (m === 'GET' && p === '/api/trips/records') return json(await tripRecords(env));
      if (m === 'GET' && p === '/api/fuel') return json(await nearbyFuel(env, url.searchParams));
      if (m === 'POST' && p === '/api/fuel/fav') return json(await setFavStation(env, await req.json()));
      if (m === 'GET' && p === '/api/fuel/fav/prices') return json(await favPrices(env));
      if (m === 'POST' && p === '/api/fuel/fav/alert') return json(await setFavAlert(env, await req.json()));
      if (m === 'GET' && p === '/api/trips') return json(await listTrips(env, clampInt(url.searchParams.get('limit'), 1, 200, 40)));
      if (m === 'GET' && (mt = p.match(/^\/api\/trips\/(\d+)$/))) return json(await getTrip(env, +mt[1]));
      if (m === 'GET' && p === '/api/maintenance') return json(await listMaint(env));
      if (m === 'POST' && p === '/api/maintenance') return json(await saveMaint(env, await req.json()));
      if (m === 'POST' && (mt = p.match(/^\/api\/maintenance\/(\d+)\/done$/))) return json(await doneMaint(env, +mt[1]));
      if (m === 'DELETE' && (mt = p.match(/^\/api\/maintenance\/(\d+)$/))) return json(await deleteMaint(env, +mt[1]));
      if (m === 'GET' && p === '/api/push/key') return json({ key: (await vapidKeys(env)).pub });
      if (m === 'POST' && p === '/api/push/subscribe') return json(await subscribe(env, await req.json()));
      if (m === 'POST' && p === '/api/push/test') {
        return json(await sendPushAll(env, { title: 'Fiesta ST', body: 'Los avisos funcionan correctamente.', url: '#estado', tag: 'test' }));
      }
      return json({ error: 'Ruta no encontrada' }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, e.status || 500);
    }
  },

  async scheduled(event, env, ctx) {
    await prepare(env);
    const st = await loadState(env);
    const minute = new Date(event.scheduledTime).getUTCMinutes();
    // Con Ford real: aparcado, una consulta cada 2 min (para pillar pronto el arranque); en marcha, cada minuto.
    const poll = src(env) !== 'ford' || st.trip || minute % 2 === 0 || (st.pollUntil && Date.now() < st.pollUntil) || (st.parkChecks && st.parkChecks.length);
    if (poll) {
      try { await ingest(env, await readCar(env), st); await fordHealth(env, null); }
      catch (e) { console.error('ingest', e); await fordHealth(env, e); }
    }
    // Tras aparcar: comprobar si se ha cerrado (el coche no avisa solo de que lo has cerrado)
    const stp = await loadState(env);
    if (src(env) === 'ford' && stp.parkChecks && stp.parkChecks.length && Date.now() >= stp.parkChecks[0]) {
      stp.parkChecks.shift();
      if (!stp.parkChecks.length) stp.parkChecks = null;
      stp.pollUntil = Date.now() + 240e3; // preguntar cada minuto un rato para ver la respuesta
      await stateStmt(env.DB, stp).run();
      try { await fordRefresh(env, { auto: true, every: 1, wake: true }); } catch (e) { console.error('parkcheck', e); }
    }
    // En marcha el coche casi no manda nada por su cuenta: se le pide el estado cada 2 min la primera hora
    // y cada 5 min después (viajes largos), hasta 8 h por trayecto.
    const st2 = await loadState(env);
    const age = st2.trip ? Date.now() - st2.trip.start_ts : 0;
    if (src(env) === 'ford' && st2.trip && age < 8 * 3600e3) {
      try { await fordRefresh(env, { auto: true, every: age < 3600e3 ? 115e3 : 295e3 }); } catch (e) { console.error('autorefresh', e); }
    }
    await parkingTimer(env);
    await daily(env, event.scheduledTime);
    try { await geoBackfill(env); } catch (e) { console.error('geo', e); }
    try { await pathBackfill(env); } catch (e) { console.error('ruta', e); }
    try { await priceHistBackfill(env); } catch (e) { console.error('histórico precios', e); }
    try { await weeklyBackup(env, event.scheduledTime); } catch (e) { console.error('copia', e); }
  }
};

// ---------- Fuente de datos ----------

async function readCar(env) {
  const car = src(env) === 'ford' ? await fordCar(env) : mockCar(Date.now());
  applyTyrePrefs(car, await getTyrePrefs(env));
  const track = await getTrack(env);
  const here = circuitAt(car.location);
  car.circuit = here ? here.name : null;
  if (here) { track.active = true; track.auto = true; track.circuit = here.name; }
  car.track = track.active ? track : null;
  // Recién aparcado y aún sin dato de cierre: se está comprobando (no asustar con "Abierto")
  const stRow = await env.DB.prepare("SELECT v FROM kv WHERE k = 'state'").first();
  const stNow = stRow ? JSON.parse(stRow.v) : {};
  const notShut = car.locked === false || (car.doors_open || []).length || (car.windows_open || []).length;
  car.lock_checking = !!notShut && car.ignition === 'off' && (!!(stNow.parkChecks && stNow.parkChecks.length) ||
    !!(stNow.parked && Date.now() - stNow.parked.ts < UNLOCKED_GRACE_S * 1000));
  // Viaje en curso (para la pantalla de conducción)
  if (stNow.trip && car.ignition !== 'off') {
    const t = stNow.trip, km = car.odometer_km != null && t.start_odo != null ? Math.max(0, car.odometer_km - t.start_odo) : null;
    const ffRow = await env.DB.prepare("SELECT v FROM kv WHERE k = 'fuel_factor'").first();
    const fuelL = t.start_fuel != null && car.fuel_pct != null ? Math.max(0, (t.start_fuel - car.fuel_pct) / 100 * TANK_L * (ffRow ? Number(ffRow.v) : 1)) : null;
    const mins = (Date.now() - t.start_ts) / 60e3;
    car.trip_live = { start_ts: t.start_ts, km, mins: Math.round(mins), avg: km && mins > 1 ? Math.round(km / (mins / 60)) : null,
      fuel_l: fuelL != null ? round(fuelL, 1) : null, l100: km > 15 && fuelL ? round(fuelL / km * 100, 1) : null, warm: !!t.warm, max_speed: t.max_speed || null };
  }
  car.alerts = Object.entries(carAlerts(car)).filter(([k]) => !(track.active && k.startsWith('tyre_')) && !(car.lock_checking && (k === 'unlocked' || k === 'open'))).map(([, v]) => v);
  return car;
}

// ---------- Ford real (mismas llamadas que la app oficial; ver pyfordpass) ----------

const FORD = {
  UA: 'okhttp/4.12.0', APP_ID: '667D773E-1BDC-4139-8AD0-2B16474E8DC7', COUNTRY: 'ESP', LOCALE: 'es-ES',
  FOUND: 'https://api.foundational.ford.com', TMC_ACC: 'https://accounts.autonomic.ai', TMC: 'https://api.autonomic.ai'
};

function jwtExp(t) {
  try {
    let p = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    while (p.length % 4) p += '=';
    return (JSON.parse(atob(p)).exp || 0) * 1000;
  } catch (e) { return 0; }
}

async function fordLoad(env) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'ford'").first();
  return row ? JSON.parse(row.v) : null;
}
async function fordSave(env, f) {
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('ford', ?)").bind(JSON.stringify(f)).run();
}

async function fordTokens(env) {
  const f = await fordLoad(env);
  if (!f || !f.cat_refresh) throw httpError('El coche no está conectado con Ford.', 409);
  const now = Date.now();
  let changed = false;
  if (!f.cat || !f.cat_exp || f.cat_exp - now < 120e3) {
    const r = await fetch(FORD.FOUND + '/api/token/v2/cat-with-refresh-token', {
      method: 'POST',
      headers: { 'application-id': FORD.APP_ID, 'content-type': 'application/json', 'user-agent': FORD.UA },
      body: JSON.stringify({ refresh_token: f.cat_refresh })
    });
    if (!r.ok) {
      f.error = `Renovar acceso: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`;
      await fordSave(env, f);
      throw httpError('Ford ha rechazado el acceso guardado. Hay que volver a conectar la cuenta.', 502);
    }
    const j = await r.json();
    f.cat = j.access_token;
    if (j.refresh_token) f.cat_refresh = j.refresh_token;
    f.cat_exp = jwtExp(f.cat) || now + (j.expires_in || 1800) * 1000;
    f.tmc = null;
    changed = true;
  }
  if (!f.tmc || !f.tmc_exp || f.tmc_exp - now < 120e3) {
    const r = await fetch(FORD.TMC_ACC + '/v1/auth/oidc/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': FORD.UA },
      body: new URLSearchParams({
        client_id: 'fordpass-prod', grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_issuer: 'fordpass', subject_token: f.cat_refresh, subject_token_type: 'urn:ietf:params:oauth:token-type:jwt'
      })
    });
    if (!r.ok) {
      f.error = `Token de telemetría: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`;
      await fordSave(env, f);
      throw httpError('Ford no ha dado acceso a la telemetría del coche.', 502);
    }
    const j = await r.json();
    f.tmc = j.access_token;
    f.tmc_exp = jwtExp(f.tmc) || now + (j.expires_in || 1800) * 1000;
    changed = true;
  }
  if (changed) { f.error = null; await fordSave(env, f); }
  return f;
}

async function fordCar(env) {
  const f = await fordTokens(env);
  const r = await fetch(`${FORD.TMC}/v1beta/telemetry/sources/fordpass/vehicles/${f.vin}:query`, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + f.tmc, 'content-type': 'application/json', 'user-agent': FORD.UA },
    body: '{}'
  });
  if (!r.ok) {
    const t = (await r.text()).slice(0, 200);
    f.error = `Telemetría: HTTP ${r.status} ${t}`;
    if (r.status === 401) f.tmc = null;
    await fordSave(env, f);
    throw httpError(`Ford no ha devuelto datos del coche (HTTP ${r.status}).`, 502);
  }
  const data = await r.json();
  // Guardamos la última respuesta en bruto (como mucho una vez por hora) para ajustar la traducción.
  const raw = await env.DB.prepare("SELECT v FROM kv WHERE k = 'ford_raw_at'").first();
  if (!raw || Date.now() - Number(raw.v) > 3600e3) {
    await env.DB.batch([
      env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('ford_raw', ?)").bind(JSON.stringify(data).slice(0, 900000)),
      env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('ford_raw_at', ?)").bind(String(Date.now()))
    ]);
  }
  return mapTelemetry(data);
}

const DOORS_ES = {
  DRIVER: 'puerta conductor', PASSENGER: 'puerta acompañante', UNSPECIFIED_FRONT: 'puerta delantera',
  REAR_LEFT: 'puerta trasera izq.', REAR_RIGHT: 'puerta trasera der.', TAILGATE: 'maletero', INNER_TAILGATE: 'maletero',
  HOOD: 'capó', HOOD_DOOR: 'capó', ROOF: 'techo'
};
const GEARS = { PARK: 'P', REVERSE: 'R', NEUTRAL: 'N', DRIVE: 'D', FIRST: 1, SECOND: 2, THIRD: 3, FOURTH: 4, FIFTH: 5, SIXTH: 6, SEVENTH: 7 };

function mapTelemetry(data) {
  const m = data.metrics || {};
  const val = k => { const e = m[k]; return e && !Array.isArray(e) && typeof e === 'object' ? e.value : undefined; };
  const num = x => (typeof x === 'number' ? x : x != null && x !== '' && !isNaN(+x) ? +x : null);
  const r1 = x => (x == null ? null : Math.round(x * 10) / 10);
  const ign = String(val('ignitionStatus') ?? 'OFF').toUpperCase();
  const running = !/OFF|LOCK/.test(ign) && /RUN|ON|START/.test(ign);
  const WHEEL = { FRONT_LEFT: 'fl', FRONT_RIGHT: 'fr', REAR_LEFT: 'rl', REAR_RIGHT: 'rr' };
  const tyres = {}, tyre_ref = {}, tyres_low = [];
  for (const t of Array.isArray(m.tirePressure) ? m.tirePressure : []) {
    const k = WHEEL[t.vehicleWheel];
    if (!k || t.value == null) continue;
    tyres[k] = Math.round(num(t.value)) / 100; // kPa → bar
    const ref = num(t.wheelPlacardFront ?? t.wheelPlacardRear);
    if (ref) tyre_ref[k] = Math.round(ref) / 100;
  }
  for (const t of Array.isArray(m.tirePressureStatus) ? m.tirePressureStatus : []) {
    const k = WHEEL[t.vehicleWheel];
    if (k && /LOW/i.test(String(t.value))) tyres_low.push(k);
  }
  for (const k in tyres) if (!tyres_low.includes(k) && tyre_ref[k] && tyres[k] < tyre_ref[k] * 0.88) tyres_low.push(k);
  const side = x => (x === 'DRIVER' ? 'izq.' : x === 'PASSENGER' ? 'der.' : '');
  const doors = Array.isArray(m.doorStatus) ? m.doorStatus : [];
  const doors_open = doors.filter(d => d.value && !/CLOSED|UNKNOWN|UNDEFINED/i.test(String(d.value)))
    .map(d => {
      const p = d.vehiclePart || d.vehicleDoor;
      if (p === 'UNSPECIFIED_FRONT') return 'puerta delantera ' + side(d.vehicleSide);
      return DOORS_ES[p] || String(p || 'puerta').toLowerCase();
    });
  if (val('hoodStatus') && !/CLOSED|UNDEFINED/i.test(String(val('hoodStatus')))) doors_open.push('capó');
  const windows_open = (Array.isArray(m.windowStatus) ? m.windowStatus : [])
    .filter(w => { const r = w.value && w.value.doubleRange; return r ? num(r.upperBound) > 0 : w.value && !/CLOSED|UNDEFINED/i.test(String(w.value)); })
    .map(w => 'ventana ' + (/REAR/.test(w.vehicleWindow) ? 'trasera ' : 'delantera ') + side(w.vehicleSide));
  let locked = null;
  const lk = m.doorLockStatus;
  if (Array.isArray(lk)) {
    const all = lk.find(d => /ALL/.test(String(d.vehicleDoor || ''))) || lk[0];
    if (all && all.value != null) locked = /LOCK/i.test(all.value) && !/UNLOCK/i.test(all.value);
  } else if (lk && lk.value != null) locked = /LOCK/i.test(lk.value) && !/UNLOCK/i.test(lk.value);
  const pos = val('position');
  const loc = pos && pos.location && pos.location.lat != null ? { lat: +pos.location.lat, lon: +pos.location.lon } : null;
  // En cambio manual Ford solo informa la marcha atrás y se queda la última lectura: si es más vieja que el arranque, no vale.
  const gUpd = m.gearLeverPosition && m.gearLeverPosition.updateTime ? Date.parse(m.gearLeverPosition.updateTime) : 0;
  const iUpd = m.ignitionStatus && m.ignitionStatus.updateTime ? Date.parse(m.ignitionStatus.updateTime) : 0;
  const gearRaw = gUpd && iUpd && gUpd < iUpd - 60e3 ? null : val('gearLeverPosition');
  let dataTs = 0;
  for (const k of ['ignitionStatus', 'position', 'odometer', 'fuelLevel', 'batteryVoltage']) {
    const t = m[k] && m[k].updateTime ? Date.parse(m[k].updateTime) : 0;
    if (t > dataTs) dataTs = t;
  }
  const brake = val('brakePedalStatus');
  return {
    ts: Date.now(),
    data_ts: dataTs || null,
    source: 'ford',
    odometer_km: r1(num(val('odometer'))),
    fuel_pct: num(val('fuelLevel')) != null ? r1(Math.min(100, num(val('fuelLevel')))) : null,
    range_km: num(val('fuelRange')) != null ? Math.round(num(val('fuelRange'))) : null,
    // Con el motor apagado, más de 13,2 V es la tensión de carga que quedó al apagar, no la de reposo: no vale
    battery_v: (() => { const v = num(val('batteryVoltage')); if (v == null) return null; const off = /OFF/i.test(String(val('ignitionStatus') || '')); return off && v > 12.9 ? null : Math.round(v * 100) / 100; })(),
    tyres,
    tyre_ref,
    tyres_low,
    locked,
    doors_open,
    windows_open,
    ignition: running ? 'run' : 'off',
    ignition_raw: ign,
    battery_soc: num(val('batteryStateOfCharge')),
    parking_brake: val('parkingBrakeStatus') ? /ON|ENGAGED/i.test(String(val('parkingBrakeStatus'))) : null,
    alarm: val('alarmStatus') || null,
    speed_kmh: running ? Math.round((num(val('speed')) || 0) * 3.6) : 0, // Ford la manda en m/s
    gear: running ? (GEARS[String(gearRaw).toUpperCase()] ?? gearRaw ?? gearFrom(Math.round((num(val('speed')) || 0) * 3.6), num(val('engineSpeed')))) : null,
    rpm: running ? Math.round(num(val('engineSpeed')) || 0) : 0,
    throttle_pct: running ? Math.round(num(val('acceleratorPedalPosition')) || 0) : 0,
    brake_pct: running && (brake === true || /ON|APPLIED|PRESS/i.test(String(brake))) ? 100 : 0,
    oil_c: num(val('engineOilTemp')),
    coolant_c: num(val('engineCoolantTemp')),
    outside_c: num(val('outsideTemperature') ?? val('ambientTemp')),
    oil_life_pct: num(val('oilLifeRemaining')),
    location: loc,
    metrics_count: Object.keys(m).length
  };
}

// Pide al coche que se despierte y mande datos nuevos (como hace la app de Ford al abrirla).
// Limitado a una vez cada 10 minutos para no gastar batería.
async function fordRefresh(env, opts = {}) {
  if (src(env) !== 'ford') return { ok: false, error: 'Solo funciona con el coche real conectado.' };
  const last = await env.DB.prepare("SELECT v FROM kv WHERE k = 'ford_refresh_at'").first();
  const wait = last ? (opts.auto ? (opts.every || 115e3) : 600e3) - (Date.now() - Number(last.v)) : 0;
  if (opts.auto && wait > 0) return { ok: false };
  if (wait > 0) return { ok: false, error: `Ya se pidió hace poco. Espera ${Math.ceil(wait / 60e3)} min para no gastar batería.` };
  const f = await fordTokens(env);
  const r = await fetch(`${FORD.TMC}/v1/command/vehicles/${f.vin}/commands`, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + f.tmc, 'content-type': 'application/json', 'user-agent': FORD.UA },
    body: JSON.stringify({ properties: {}, tags: {}, type: 'statusRefresh', wakeUp: !opts.auto || !!opts.wake })
  });
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('ford_refresh_at', ?)").bind(String(Date.now())).run();
  await env.DB.prepare("DELETE FROM kv WHERE k = 'live_cache'").run();
  if (!r.ok) return { ok: false, error: `Ford no ha aceptado la petición (HTTP ${r.status}).` };
  return { ok: true };
}

async function fordConnect(env, b) {
  if (!b || typeof b.cat_refresh !== 'string' || typeof b.vin !== 'string' || b.vin.length !== 17) throw httpError('Faltan los datos de Ford', 400);
  const f = { cat: typeof b.cat === 'string' ? b.cat : null, cat_refresh: b.cat_refresh, vin: b.vin.toUpperCase(), connected_at: Date.now() };
  f.cat_exp = f.cat ? jwtExp(f.cat) : 0;
  await fordSave(env, f);
  let car;
  try { car = await fordCar(env); }
  catch (e) { return { ok: false, error: e.message + ((await fordLoad(env)).error ? ' · ' + (await fordLoad(env)).error : '') }; }
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('source', 'ford')").run();
  ready = false;
  return {
    ok: true,
    summary: { fuel_pct: car.fuel_pct, range_km: car.range_km, odometer_km: car.odometer_km, battery_v: car.battery_v, ignition: car.ignition_raw, fields: car.metrics_count }
  };
}

async function fordStatus(env) {
  const f = await fordLoad(env);
  const raw = await env.DB.prepare("SELECT v FROM kv WHERE k = 'ford_raw'").first();
  return {
    source: src(env), connected: !!(f && f.cat_refresh), vin_end: f && f.vin ? f.vin.slice(-6) : null,
    connected_at: f && f.connected_at, error: f && f.error,
    health: await (async () => { const h = await env.DB.prepare("SELECT v FROM kv WHERE k = 'ford_health'").first(); return h ? JSON.parse(h.v) : null; })(),
    last_data: await (async () => { const r = await env.DB.prepare('SELECT MAX(ts) AS t FROM snapshots').first(); return r ? r.t : null; })(),
    metrics: raw ? Object.keys(JSON.parse(raw.v).metrics || {}) : []
  };
}

// Coche simulado: función pura del tiempo, así el histórico es coherente.
function mockCar(now) {
  const BASE = Date.UTC(2026, 9, 1);
  const DAY = 86400e3;
  const local = now + 3600e3; // hora peninsular aprox.
  const days = Math.floor((local - BASE) / DAY);
  const minF = ((local - BASE) % DAY) / 60000;
  const trips = [[450, 20, 20], [960, 25, 25]]; // inicio (min), duración (min), km
  const rnd = d => Math.abs((Math.sin(d * 12.9898) * 43758.5453) % 1);
  const factor = d => 0.072 + 0.018 * rnd(d); // l/km

  let todayKm = 0, driving = false, tripMin = 0, sinceEnd = 9999, pos = 0;
  trips.forEach(([start, dur, km], i) => {
    if (minF >= start + dur) { todayKm += km; sinceEnd = Math.min(sinceEnd, minF - start - dur); pos = i === 0 ? 1 : 0; }
    else if (minF >= start) { const q = (minF - start) / dur; todayKm += km * q; driving = true; tripMin = minF - start; pos = i === 0 ? q : 1 - q; }
  });
  if (minF < trips[0][0]) sinceEnd = minF + 1440 - (trips[1][0] + trips[1][1]);

  let used = 0;
  for (let d = 0; d < days; d++) used += 45 * factor(d);
  used += todayKm * factor(days);
  const usable = TANK_L * 0.8;
  const fuel = 95 - ((used % usable) / TANK_L) * 100;

  const outside = Math.round(12 + 6 * Math.sin((minF / 1440 - 0.375) * 2 * Math.PI));
  const t = now / 1000;
  let speed = 0, gear = 0, rpm = 0, throttle = 0, brake = 0, oil, coolant;
  if (driving) {
    speed = Math.max(0, Math.min(140, Math.round(55 + 35 * Math.sin(t / 37) + 15 * Math.sin(t / 9))));
    gear = speed < 15 ? 1 : speed < 30 ? 2 : speed < 50 ? 3 : speed < 70 ? 4 : speed < 95 ? 5 : 6;
    rpm = Math.round(800 + speed * [0, 110, 65, 47, 37, 30, 25][gear] + (Math.sin(t / 3) > 0.9 ? 1800 : 0));
    throttle = Math.max(0, Math.min(100, Math.round(20 + 25 * Math.sin(t / 5))));
    brake = throttle < 8 ? 30 : 0;
    oil = Math.round(Math.min(98, outside + tripMin * 6));
    coolant = Math.round(Math.min(92, outside + tripMin * 9));
  } else {
    oil = Math.round(outside + (90 - outside) * Math.exp(-sinceEnd / 40));
    coolant = Math.round(outside + (88 - outside) * Math.exp(-sinceEnd / 35));
  }

  const A = [40.4169, -3.7035], B = [40.4722, -3.6826];
  const lat = A[0] + (B[0] - A[0]) * pos;
  const lon = A[1] + (B[1] - A[1]) * pos + 0.012 * Math.sin(pos * Math.PI);
  const rr = +(2.45 - (days % 20) * 0.02).toFixed(2);
  const base = 12.62 - 0.06 * rnd(days + 7);
  const battery = driving ? 14.2 : base - Math.min(0.15, sinceEnd / 8000);

  return {
    ts: now,
    source: 'mock',
    odometer_km: Math.round((17000 + days * 45 + todayKm) * 10) / 10,
    fuel_pct: Math.round(fuel * 10) / 10,
    range_km: Math.round((fuel / 100) * TANK_L / factor(days)),
    battery_v: Math.round(battery * 100) / 100,
    tyres: { fl: 2.5, fr: 2.5, rl: 2.45, rr },
    locked: !driving,
    doors_open: [],
    windows_open: [],
    ignition: driving ? 'run' : 'off',
    speed_kmh: speed, gear, rpm,
    throttle_pct: throttle, brake_pct: brake,
    oil_c: oil, coolant_c: coolant, outside_c: outside,
    location: { lat: +lat.toFixed(5), lon: +lon.toFixed(5) }
  };
}

function carAlerts(c) {
  const running = c.ignition !== 'off';
  const out = {};
  for (const k in c.tyres || {}) {
    const v = c.tyres[k];
    const low = Array.isArray(c.tyres_low) ? c.tyres_low.includes(k) : v != null && v < TYRE_MIN;
    const ref = c.tyre_ref && c.tyre_ref[k] ? `, recomendada ${fmt(c.tyre_ref[k], 2)}` : '';
    if (low) out['tyre_' + k] = `Presión baja en la rueda ${TYRE_NAMES[k] || k} (${fmt(v, 2)} bar${ref})`;
  }
  if (!running && c.battery_v != null && c.battery_v < BATT_MIN) out.batt = `Batería de 12 V baja (${fmt(c.battery_v, 1)} V)`;
  if (!running && c.locked === false) out.unlocked = 'El coche está aparcado sin cerrar';
  const open = [...(c.doors_open || []), ...(c.windows_open || [])];
  if (!running && open.length) out.open = 'Abierto: ' + open.join(', ');
  if (c.fuel_pct != null && c.fuel_pct < FUEL_MIN) out.fuel = `Queda poco combustible (${Math.round(c.fuel_pct)} %, unos ${c.range_km} km)`;
  return out;
}

// ---------- Procesado: histórico, repostajes, trayectos, avisos ----------

function newState() {
  return { last: null, snapFuel: null, trip: null, alerts: [], unlockedSince: null };
}

async function loadState(env) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'state'").first();
  return row ? { ...newState(), ...JSON.parse(row.v) } : newState();
}

function stateStmt(db, st) {
  return db.prepare("INSERT OR REPLACE INTO kv VALUES ('state', ?)").bind(JSON.stringify(st));
}

function processCar(db, st, c, opts = {}) {
  const stmts = [], notes = [];
  const running = c.ignition !== 'off';
  const gap = running ? (opts.gapDriving || GAP_DRIVING_S) : (opts.gapParked || GAP_PARKED_S);
  const ignChanged = st.last && (st.last.ignition !== 'off') !== running;

  // Histórico y repostajes
  const sameData = c.data_ts && st.last && st.last.dts === c.data_ts && c.ts - st.last.ts < 1800e3;
  if ((!st.last || c.ts - st.last.ts >= gap * 1000 || ignChanged) && !(sameData && !ignChanged)) {
    stmts.push(db.prepare('INSERT OR REPLACE INTO snapshots VALUES (?, ?, ?, ?, ?)')
      .bind(c.ts, c.odometer_km, c.fuel_pct, c.battery_v, JSON.stringify(c)));
    if (st.snapFuel != null && c.fuel_pct - st.snapFuel >= 15) {
      const litres = round(((c.fuel_pct - st.snapFuel) / 100) * TANK_L, 1);
      stmts.push(db.prepare('INSERT OR REPLACE INTO refuels (ts, odometer, fuel_before, fuel_after, litres) VALUES (?, ?, ?, ?, ?)')
        .bind(c.ts, c.odometer_km, st.snapFuel, c.fuel_pct, litres));
      notes.push({ title: 'Repostaje detectado', body: `Unos ${fmt(litres, 1)} L. Toca para apuntar el precio.`, url: '#datos', tag: 'refuel' });
      st.newRefuel = { ts: c.ts, litres, lat: c.location?.lat, lon: c.location?.lon };
      st.fullEst = 0; // depósito lleno: se empieza a contar de cero
    }
    st.snapFuel = c.fuel_pct;
    st.last = { ts: c.ts, ignition: c.ignition, dts: c.data_ts || null };
  }

  // Trayectos
  if (running) {
    if (!st.trip) {
      if (opts.guard && guardActive(opts.guard, c.ts)) {
        notes.push({ title: '⚠️ El coche se ha encendido', body: `Tu Fiesta ST se ha puesto en marcha a las ${hhmm(c.ts)}. Si no eres tú, revisa dónde está.`, url: '#estado', tag: 'guard', urgent: true });
      }
      if (c.tyres && !c.track && (c.coolant_c ?? c.oil_c ?? 99) < 45) st.coldTyres = { ts: c.data_ts || c.ts, ...c.tyres };
      st.trip = {
        start_ts: c.data_ts && c.data_ts < c.ts ? c.data_ts : c.ts, start_odo: c.odometer_km, start_fuel: c.fuel_pct, start_oil: c.oil_c ?? c.coolant_c,
        start: c.location ? [c.location.lat, c.location.lon] : null, track: !!c.track,
        pts: [], n: 0, spd: 0, thr: 0, hi: 0, max_speed: 0, max_rpm: 0, max_oil: 0, warm: false, moving: 0, last_dts: 0
      };
    }
    const t = st.trip;
    // Solo cuentan las lecturas nuevas (Ford repite la última hasta que el coche manda otra)
    const fresh = !c.data_ts || c.data_ts !== t.last_dts;
    t.last_dts = c.data_ts || 0;
    if (fresh) {
    t.n++;
    if ((c.speed_kmh || 0) > 0) t.moving = (t.moving || 0) + 1;
    t.spd += c.speed_kmh || 0;
    t.thr += c.throttle_pct || 0;
    if ((c.rpm || 0) >= 4000) t.hi++;
    t.max_speed = Math.max(t.max_speed, c.speed_kmh || 0);
    t.max_rpm = Math.max(t.max_rpm, c.rpm || 0);
    t.max_oil = Math.max(t.max_oil, c.oil_c ?? c.coolant_c ?? 0);
    t.end_ts = c.ts; t.end_odo = c.odometer_km; t.end_fuel = c.fuel_pct;
    if (c.location) {
      t.end = [c.location.lat, c.location.lon];
      const lp = t.pts[t.pts.length - 1];
      const pts_ts = c.data_ts || c.ts;
      if (!lp || pts_ts - lp[3] >= POINT_GAP_S * 1000) t.pts.push([c.location.lat, c.location.lon, c.speed_kmh || 0, pts_ts]);
    }
    }
    const warmT = c.oil_c ?? c.coolant_c, warmMax = c.oil_c != null ? OIL_WARM : 85;
    if (!t.warm && t.start_oil != null && t.start_oil < 60 && warmT >= warmMax) {
      t.warm = true;
      notes.push({ title: 'Motor a temperatura', body: `${c.oil_c != null ? 'Aceite' : 'Refrigerante'} a ${warmT} °C. Ya puedes apretar.`, url: '#motor', tag: 'warm' });
    }
  } else if (st.trip) {
    const t = st.trip;
    const endOdo = c.odometer_km ?? t.end_odo;
    // El cuentakilómetros va en km enteros: en trayectos cortos se usa la distancia GPS entre los puntos
    const gp = [t.start, ...t.pts.map(p => [p[0], p[1]]), c.location ? [c.location.lat, c.location.lon] : null].filter(Boolean);
    let gps = 0; for (let i = 1; i < gp.length; i++) gps += distKm(gp[i - 1][0], gp[i - 1][1], gp[i][0], gp[i][1]);
    const odoKm = endOdo - t.start_odo;
    const km = round(odoKm >= 2 ? odoKm : Math.max(odoKm, gps * 1.2), 1); // ×1,2: las calles no van en línea recta
    if (km >= 0.15) {
      if (c.data_ts && c.data_ts > t.start_ts) t.end_ts = c.data_ts; // hora real a la que se apagó
      const dur = Math.max(60, Math.round((t.end_ts - t.start_ts) / 1000));
      const noLive = !t.moving; // el coche no mandó nada en marcha: sin velocidad ni rpm reales
      // El aforador no es lineal: se corrige con el factor calibrado en los repostajes (litros reales / litros según aforador)
      let usedL = Math.max(0, ((t.start_fuel - (c.fuel_pct ?? t.end_fuel)) / 100) * TANK_L) * (opts.fuelFactor || 1);
      // Recién lleno, el aforador se queda clavado en 100 % los primeros 30-60 km: se estima con tu consumo medio
      // y, cuando por fin baja, se resta lo ya estimado para no contarlo dos veces
      const endF = c.fuel_pct ?? t.end_fuel, ref = opts.refL100 || 7.5;
      if (t.start_fuel >= 99) {
        const est = km * ref / 100;
        if (endF >= 99) { usedL = est; st.fullEst = (st.fullEst || 0) + est; }
        else { usedL = Math.max(est * 0.5, usedL - (st.fullEst || 0)); st.fullEst = 0; }
      } else st.fullEst = 0;
      const pts = t.pts.slice();
      if (c.location) pts.push([c.location.lat, c.location.lon, 0, c.data_ts || c.ts]);
      const end = c.location ? [c.location.lat, c.location.lon] : t.end;
      const sess = tripCircuit(t, pts, c);
      stmts.push(db.prepare(`INSERT INTO trips (start_ts, end_ts, start_odo, end_odo, km, duration_s, avg_speed, max_speed,
          max_rpm, max_oil, avg_throttle, rpm_high_pct, fuel_used_l, start_lat, start_lon, end_lat, end_lon, points, track, circuit)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(t.start_ts, t.end_ts, t.start_odo, endOdo, km, dur, Math.round(km / (dur / 3600)), noLive ? null : t.max_speed,
          noLive ? null : t.max_rpm, Math.max(t.max_oil, c.oil_c ?? c.coolant_c ?? 0), noLive ? null : Math.round(t.thr / Math.max(1, t.n)), noLive ? null : Math.round((t.hi / Math.max(1, t.n)) * 100), round(usedL, 2),
          t.start?.[0] ?? null, t.start?.[1] ?? null, end?.[0] ?? null, end?.[1] ?? null, JSON.stringify(pts), sess.track ? 1 : 0, sess.circuit));
    }
    st.trip = null;
    if (c.location) st.parked = { ts: c.ts, lat: c.location.lat, lon: c.location.lon };
    st.parkChecks = PARK_CHECKS_S.map(x => (c.data_ts || c.ts) + x * 1000);
  } else if (opts.guard && c.location && st.parked && distKm(st.parked.lat, st.parked.lon, c.location.lat, c.location.lon) > 0.3 && !st.movedAlerted) {
    st.movedAlerted = true;
    notes.push({ title: '⚠️ El coche se ha movido', body: 'Se ha desplazado más de 300 m con el motor apagado (¿grúa?). Revisa la ubicación.', url: '#estado', tag: 'moved', urgent: true });
  }
  if (running) st.movedAlerted = false;

  // Llegada / salida de un circuito
  // Solo cuenta si se queda dentro: aparcado en el recinto o 5 lecturas seguidas en marcha (no al pasar por al lado).
  const circ = circuitAt(c.location);
  const key = circ ? (circ.group || circ.id) : null;
  st.circuitPolls = key && key === st.circuitKey ? (st.circuitPolls || 0) + 1 : key ? 1 : 0;
  st.circuitKey = key;
  const settled = circ && (!running || st.circuitPolls >= 5);
  if (settled && st.circuit !== key && !opts.silent) {
    notes.push({ title: '🏁 ' + (circ.group === 'nring' ? 'Nürburgring' : circ.name), body: 'Modo circuito activado: sin avisos de presión y trayectos guardados como circuito.', url: '#viajes', tag: 'circuit' });
  }
  if (settled) st.circuit = key; else if (!circ) st.circuit = null;
  if (circ && st.trip) {
    st.trip.zones = [...new Set([...(st.trip.zones || []), circ.id])];
    st.trip.circuit = circ.group ? null : circ.name;
  }

  // Avisos (solo cuando aparecen)
  const allShut = c.locked && !(c.doors_open || []).length && !(c.windows_open || []).length;
  if (st.parkChecks && (allShut || (c.ignition && c.ignition !== 'off'))) st.parkChecks = null; // ya cerrado del todo (o vuelve a arrancar)
  const cur = carAlerts(c);
  if (cur.unlocked || cur.open) {
    st.unlockedSince = st.unlockedSince || c.ts;
    // Margen tras aparcar: la lectura de "apagado" llega con la puerta aún abierta
    if (c.ts - st.unlockedSince < UNLOCKED_GRACE_S * 1000) { delete cur.unlocked; delete cur.open; }
  } else st.unlockedSince = null;
  if (c.track) for (const k in cur) if (k.startsWith('tyre_')) delete cur[k];
  for (const k in cur) {
    if (!st.alerts.includes(k)) notes.push({ title: 'Fiesta ST', body: cur[k], url: '#estado', tag: k });
  }
  st.alerts = Object.keys(cur);
  return { stmts, notes };
}

async function ingest(env, car, st) {
  st = st || await loadState(env);
  applyTyrePrefs(car, await getTyrePrefs(env));
  const guard = await getGuard(env);
  const ff = await env.DB.prepare("SELECT v FROM kv WHERE k = 'fuel_factor'").first();
  let refL100 = null;
  if (st.trip) { // consumo medio reciente (sin circuito), para cuando el aforador está clavado en lleno
    try { const q = await env.DB.prepare('SELECT SUM(fuel_used_l) l, SUM(km) km FROM trips WHERE COALESCE(track, 0) = 0 AND fuel_used_l > 0 AND km >= 3 AND start_ts > ?').bind(Date.now() - 60 * 864e5).first(); if (q && q.km > 50) refL100 = q.l / q.km * 100; } catch (e) {}
  }
  const { stmts, notes } = processCar(env.DB, st, car, { guard, fuelFactor: ff ? Number(ff.v) : 1, refL100 });
  if (car.ignition === 'off' && car.location && !st.parked) {
    st.parked = { ts: car.data_ts || car.ts, lat: car.location.lat, lon: car.location.lon };
    const has = await env.DB.prepare("SELECT 1 AS x FROM kv WHERE k = 'parking'").first();
    if (!has) stmts.push(env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('parking', ?)").bind(JSON.stringify({ ...st.parked, note: null, timer_at: null })));
  }
  if (st.trip == null && st.parked && st.parked.ts === car.ts) {
    stmts.push(env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('parking', ?)").bind(JSON.stringify({ ...st.parked, note: null, timer_at: null })));
  }
  const nr = st.newRefuel;
  delete st.newRefuel;
  if (nr) {
    // Foto del surtidor hecha antes de que el coche avisara del repostaje
    const pend = await env.DB.prepare("SELECT v FROM kv WHERE k = 'pending_pump'").first();
    if (pend) {
      const pp = JSON.parse(pend.v);
      if (nr.ts - pp.ts < 12 * 3600e3 && nr.ts - pp.ts > -3600e3) {
        nr.pump = pp;
        const ix = notes.findIndex(x => x.tag === 'refuel'); if (ix >= 0) notes.splice(ix, 1);
        notes.push({ title: 'Repostaje apuntado', body: `${fmt(pp.litres, 2)} L a ${fmt(pp.price_l, 3)} €/L = ${fmt(pp.total, 2)} € (de la foto del surtidor).`, url: '#datos', tag: 'refuel' });
        nr.done = true;
      }
    }
  }
  if (nr && !nr.done && nr.lat != null) {
    try {
      const type = await userFuelType(env);
      const { list } = await fuelStationsNear(env, nr.lat, nr.lon);
      const near = list.map(s => ({ ...s, km: distKm(nr.lat, nr.lon, s.lat, s.lon) })).filter(s => s.km < 0.35 && s['p' + type]).sort((a, b) => a.km - b.km)[0];
      if (near) {
        const price = near['p' + type];
        const total = round(price * nr.litres, 2);
        stmts.push(env.DB.prepare('UPDATE refuels SET price_total = ?, station = ?, price_auto = 1 WHERE ts = ? AND price_total IS NULL').bind(total, near.name, nr.ts));
        const n = notes.find(x => x.tag === 'refuel');
        if (n) n.body = `${near.name}: unos ${fmt(nr.litres, 1)} L a ${fmt(price, 3)} €/L ≈ ${fmt(total, 2)} €. Toca para corregirlo.`;
      }
    } catch (e) { console.error('precio auto', e); }
  }
  // Repostaje inteligente: al bajar del 20 % (una vez por depósito), con el precio de tu gasolinera
  if (car.fuel_pct != null) {
    if (car.fuel_pct >= 40) st.fuelWarned = false;
    else if (car.fuel_pct < 20 && !st.fuelWarned) {
      st.fuelWarned = true;
      let body = `Te quedan unos ${car.range_km ?? '—'} km (${Math.round(car.fuel_pct)} %).`;
      try {
        const type = await userFuelType(env);
        const fav = await favStation(env, type, car.location && car.location.lat, car.location && car.location.lon);
        if (fav && !fav.missing && fav.price) body += ` ${fav.name} ${titleCase(fav.town)} hoy a ${fmt(fav.price, 3)} €/L${fav.km != null ? ` (a ${fmt(fav.km, 1)} km)` : ''}: lleno por unos ${fmt(fav.price * TANK_L * (1 - car.fuel_pct / 100), 0)} €.`;
        const adv = await refuelAdvice(env);
        if (adv && adv.short) body += ' ' + adv.short;
      } catch (e) { /* sin precio */ }
      notes.push({ title: '⛽ Toca repostar', body, url: '#datos', tag: 'fuel_low' });
    }
  }
  if (st.coldTyres) {
    const ct = st.coldTyres; delete st.coldTyres;
    const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'cold_tyres'").first();
    const day = new Date(ct.ts + 3600e3).toISOString().slice(0, 10);
    const hist = (row ? JSON.parse(row.v) : []).filter(h => h.d !== day);
    hist.push({ d: day, ts: ct.ts, fl: ct.fl, fr: ct.fr, rl: ct.rl, rr: ct.rr, src: 'arranque' });
    while (hist.length > 30) hist.shift();
    stmts.push(env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('cold_tyres', ?)").bind(JSON.stringify(hist)));
  }
  stmts.push(stateStmt(env.DB, st));
  await env.DB.batch(stmts);
  if (nr && nr.pump) {
    try { await applyPump(env, nr.ts, nr.pump); await env.DB.prepare("DELETE FROM kv WHERE k = 'pending_pump'").run(); }
    catch (e) { console.error('foto surtidor', e); }
  }
  for (const n of notes) await sendPushAll(env, n);
}

function titleCase(t) { return String(t || '').toLowerCase().replace(/(^|[\s-])\p{L}/gu, m => m.toUpperCase()); }

// Revisión diaria a las 9:00: mantenimiento y batería.
async function daily(env, when) {
  const local = new Date(when + 3600e3);
  if (local.getUTCHours() !== 9) return;
  const day = local.toISOString().slice(0, 10);
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'daily'").first();
  if (row && row.v === day) return;
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('daily', ?)").bind(day).run();

  try {
    const { items } = await listMaint(env);
    const due = items.filter(i => i.status === 'vencido' || i.status === 'pronto');
    if (due.length) {
      await sendPushAll(env, {
        title: 'Mantenimiento', url: '#taller', tag: 'maint',
        body: due.map(i => `${i.name}: ${i.summary}`).join(' · ')
      });
    }
  } catch (e) { console.error('mantenimiento', e); }
  if (local.getUTCDay() === 1) {
    try { await sendPushAll(env, await weeklySummary(env)); } catch (e) { console.error('semanal', e); }
  }
  if (local.getUTCDate() === 1) {
    try {
      const prev = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
      const ms = await monthSummary(env, prev);
      if (ms.trips) await sendPushAll(env, { title: '📊 Resumen de ' + ms.label, body: ms.text, url: '#viajes', tag: 'month' });
    } catch (e) { console.error('mensual', e); }
  }
  // Fechas (ITV, seguro, impuesto): a 30, 7 y 1 días y el mismo día
  try {
    const { items: dl } = await listDeadlines(env);
    const hits = dl.filter(d => d.days != null && [30, 7, 1, 0].includes(d.days));
    if (hits.length) await sendPushAll(env, { title: 'Fechas del coche', url: '#taller', tag: 'deadline',
      body: hits.map(d => `${d.name}: ${d.days === 0 ? 'vence hoy' : d.days === 1 ? 'vence mañana' : 'vence en ' + d.days + ' días'}`).join(' · ') });
  } catch (e) { console.error('fechas', e); }
  // Coche parado varios días con la batería baja
  const st = await loadState(env);
  const last = await env.DB.prepare('SELECT battery_v AS battery FROM snapshots ORDER BY ts DESC LIMIT 1').first();
  if (st.parked && !st.trip && Date.now() - st.parked.ts > 3 * 86400e3 && last && last.battery != null && last.battery < 12.3) {
    await sendPushAll(env, { title: 'Batería baja', body: `Lleva ${Math.floor((Date.now() - st.parked.ts) / 86400e3)} días parado y la batería está a ${fmt(last.battery, 2)} V. Arráncalo y da una vuelta de 20 min.`, url: '#estado', tag: 'batt_idle' });
  }
  try { await favPriceDaily(env); } catch (e) { console.error('precio habitual', e); }
  try { await slowPuncture(env, day); } catch (e) { console.error('pinchazo', e); }
  try { await shortTripsBattery(env, day); } catch (e) { console.error('trayectos cortos', e); }
  try { await calibrateGears(env); } catch (e) { console.error('marchas', e); }
  try { await pruneOld(env); } catch (e) { console.error('limpieza', e); }
  const b = await getBattery(env, 14);
  if (b.status === 'bajando') {
    await sendPushAll(env, { title: 'Batería de 12 V', body: `Va bajando unos ${fmt(Math.abs(b.slope), 2)} V al día. Conviene revisarla.`, url: '#datos', tag: 'batt_trend' });
  }
}

// ---------- Base de datos ----------

let ready = false, SRC = null;
function src(env) { return SRC || env.SOURCE || 'mock'; }
async function prepare(env) {
  const db = env.DB;
  const [, srcRow, ccRes] = await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)'),
    db.prepare("SELECT v FROM kv WHERE k = 'source'"),
    db.prepare("SELECT v FROM kv WHERE k = 'custom_circuits'")
  ]);
  const ccRow = ccRes;
  try { CUSTOM_CIRCUITS = JSON.parse((ccRow && ccRow.results[0] && ccRow.results[0].v) || '[]'); } catch (e) { CUSTOM_CIRCUITS = []; }
  try { const cc = await db.prepare("SELECT v FROM kv WHERE k = 'car_cfg'").first(); if (cc) { const o = JSON.parse(cc.v); if (o.tank_l > 20 && o.tank_l < 150) TANK_L = o.tank_l; } } catch (e) {}
  try { const g = await db.prepare("SELECT v FROM kv WHERE k = 'gear_ratios'").first(); if (g) { const a = JSON.parse(g.v); if (Array.isArray(a) && a.length === 6) GEAR_KMH_PER_1000 = a; } } catch (e) {}
  const s = (srcRow.results && srcRow.results[0] && srcRow.results[0].v) || env.SOURCE || 'mock';
  if (ready && s === SRC) return;
  SRC = s;
  const ver = await db.prepare("SELECT v FROM kv WHERE k = 'schema'").first();
  if (!ver || ver.v !== SCHEMA) {
    // Versión anterior solo con datos de prueba: se recrea.
    await db.batch([
      db.prepare('DROP TABLE IF EXISTS snapshots'),
      db.prepare('DROP TABLE IF EXISTS refuels'),
      db.prepare('DROP TABLE IF EXISTS trips'),
      db.prepare("DELETE FROM kv WHERE k IN ('demo', 'state', 'live_cache')")
    ]);
  }
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS snapshots (ts INTEGER PRIMARY KEY, odometer REAL, fuel_pct REAL, battery_v REAL, data TEXT)'),
    db.prepare('CREATE TABLE IF NOT EXISTS refuels (ts INTEGER PRIMARY KEY, odometer REAL, fuel_before REAL, fuel_after REAL, litres REAL, price_total REAL, station TEXT, price_auto INTEGER)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS trips (id INTEGER PRIMARY KEY AUTOINCREMENT, start_ts INTEGER, end_ts INTEGER,
      start_odo REAL, end_odo REAL, km REAL, duration_s INTEGER, avg_speed INTEGER, max_speed INTEGER, max_rpm INTEGER,
      max_oil INTEGER, avg_throttle INTEGER, rpm_high_pct INTEGER, fuel_used_l REAL,
      start_lat REAL, start_lon REAL, end_lat REAL, end_lon REAL, points TEXT)`),
    db.prepare('CREATE INDEX IF NOT EXISTS trips_start ON trips (start_ts)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS maintenance (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      interval_km INTEGER, interval_months INTEGER, last_km REAL, last_date TEXT, notes TEXT)`),
    db.prepare('CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, sub TEXT, created INTEGER)'),
    db.prepare("INSERT OR REPLACE INTO kv VALUES ('schema', ?)").bind(SCHEMA)
  ]);
  try { await db.prepare('ALTER TABLE trips ADD COLUMN track INTEGER DEFAULT 0').run(); } catch (e) { /* ya existe */ }
  try { await db.prepare('ALTER TABLE trips ADD COLUMN circuit TEXT').run(); } catch (e) { /* ya existe */ }
  try { await db.prepare('ALTER TABLE refuels ADD COLUMN price_l REAL').run(); } catch (e) { /* ya existe */ }
  try { await db.prepare('ALTER TABLE refuels ADD COLUMN photo INTEGER').run(); } catch (e) { /* ya existe */ }
  try { await db.prepare('ALTER TABLE trips ADD COLUMN path TEXT').run(); } catch (e) { /* ya existe */ }
  await db.prepare('CREATE TABLE IF NOT EXISTS geo (k TEXT PRIMARY KEY, name TEXT, at INTEGER)').run();
  const mc = await db.prepare('SELECT COUNT(*) AS n FROM maintenance').first();
  if (!mc.n) {
    await db.batch(DEFAULT_MAINT.map(([n, km, mo]) =>
      db.prepare('INSERT INTO maintenance (name, interval_km, interval_months) VALUES (?, ?, ?)').bind(n, km, mo)));
  }
  const demo = await db.prepare("SELECT v FROM kv WHERE k = 'demo'").first();
  if (src(env) === 'ford' && demo) {
    // Al pasar a datos reales se borran los de prueba (el mantenimiento se conserva).
    await db.batch([
      db.prepare('DELETE FROM snapshots'),
      db.prepare('DELETE FROM refuels'),
      db.prepare('DELETE FROM trips'),
      db.prepare("DELETE FROM kv WHERE k IN ('demo', 'state', 'live_cache', 'parking')")
    ]);
  } else if (src(env) !== 'ford' && !demo) {
    await backfillMock(env);
  }
  ready = true;
}

async function backfillMock(env) {
  // 30 días simulados: cada minuto en marcha, cada 5 min aparcado.
  const db = env.DB;
  const st = newState();
  const all = [];
  const now = Date.now();
  let ts = now - 30 * 86400e3;
  while (ts < now) {
    const c = mockCar(ts);
    all.push(...processCar(db, st, c, { gapParked: 1800, gapDriving: 300 }).stmts);
    ts += c.ignition !== 'off' ? 60e3 : 300e3;
  }
  delete st.newRefuel;
  if (st.parked) all.push(db.prepare("INSERT OR REPLACE INTO kv VALUES ('parking', ?)").bind(JSON.stringify({ ...st.parked, note: null, timer_at: null })));
  all.push(stateStmt(db, st));
  all.push(db.prepare("INSERT OR REPLACE INTO kv VALUES ('demo', '1')"));
  for (let i = 0; i < all.length; i += 250) await db.batch(all.slice(i, i + 250));
}

// ---------- Endpoints ----------

async function getLive(env, ctx) {
  if (src(env) === 'ford') {
    const cached = await env.DB.prepare("SELECT v FROM kv WHERE k = 'live_cache'").first();
    if (cached) {
      const c = JSON.parse(cached.v);
      if (Date.now() - c.ts < LIVE_MIN_INTERVAL_S * 1000) return c;
    }
  }
  const car = await readCar(env);
  if (src(env) === 'ford') {
    await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('live_cache', ?)").bind(JSON.stringify(car)).run();
  }
  await ingest(env, car);
  return car;
}

async function getHistory(env, days) {
  const from = Date.now() - days * 86400e3;
  const { results } = await env.DB.prepare(
    'SELECT ts, odometer, fuel_pct, battery_v FROM snapshots WHERE ts >= ? ORDER BY ts'
  ).bind(from).all();
  const step = Math.max(1, Math.ceil(results.length / 400));
  return { days, points: results.filter((_, i) => i % step === 0 || i === results.length - 1) };
}

async function getBattery(env, days) {
  const from = Date.now() - days * 86400e3;
  const { results } = await env.DB.prepare(
    `SELECT date((ts + 3600000) / 1000, 'unixepoch') AS d, MIN(battery_v) AS min, MAX(battery_v) AS max
     FROM snapshots WHERE ts >= ? AND json_extract(data, '$.ignition') = 'off' GROUP BY d ORDER BY d`
  ).bind(from).all();
  const last7 = results.slice(-7);
  let slope = 0;
  if (last7.length >= 3) {
    const n = last7.length, xs = last7.map((_, i) => i), ys = last7.map(r => r.min);
    const mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
    const num = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
    const den = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
    slope = den ? num / den : 0;
  }
  const lastMin = results.length ? results[results.length - 1].min : null;
  const status = lastMin == null ? 'sin datos' : lastMin < BATT_MIN ? 'baja' : slope < -0.03 ? 'bajando' : 'estable';
  return { days: results, slope: round(slope, 3), status };
}

async function fuelFactor(env) {
  const r = await env.DB.prepare("SELECT v FROM kv WHERE k = 'fuel_factor'").first();
  const f = r ? Number(r.v) : 1;
  return f > 0.7 && f < 1.3 ? f : 1;
}

async function getRefuels(env) {
  const { results } = await env.DB.prepare('SELECT * FROM refuels ORDER BY ts').all();
  const ff = await fuelFactor(env);
  let totalUsed = 0, totalKm = 0;
  const list = results.map((r, i) => {
    const p = results[i - 1];
    let km = null, l100 = null;
    if (p) {
      km = round(r.odometer - p.odometer, 1);
      // Lleno a lleno (los dos al 97 % o más): los litros que entran son exactamente lo gastado. Si no, el aforador corregido.
      const full = p.fuel_after >= 97 && r.fuel_after >= 97 && r.litres > 0;
      const used = full ? r.litres : ((p.fuel_after - r.fuel_before) / 100) * TANK_L * ff;
      r.full_to_full = full;
      if (km > 20 && r.fuel_before != null && p.fuel_after != null) { l100 = round((used / km) * 100, 1); totalUsed += used; totalKm += km; }
    }
    const price_l = r.price_total && r.litres ? round(r.price_total / r.litres, 3) : r.price_l ?? null;
    return { ...r, km, l100, price_l };
  }).reverse();
  // Depósito actual: lo más fiable para el consumo (muchos km, sin el error del aforador en trayectos cortos)
  let tank = null;
  const last = results[results.length - 1];
  const now = await env.DB.prepare('SELECT odometer, fuel_pct FROM snapshots WHERE odometer IS NOT NULL AND fuel_pct IS NOT NULL ORDER BY ts DESC LIMIT 1').first();
  if (last && now && last.fuel_after != null) {
    const km = round(now.odometer - last.odometer, 0);
    const used = Math.max(0, (last.fuel_after - now.fuel_pct) / 100 * TANK_L * ff);
    const left = Math.max(0, TANK_L - (100 - now.fuel_pct) / 100 * TANK_L * ff);
    const l100 = km >= 50 ? round(used / km * 100, 1) : null;
    tank = { since: last.ts, km, used_l: round(used, 1), l100, left_l: round(left, 1), range_km: l100 ? Math.round(left / l100 * 100) : null };
  }
  // Último depósito cerrado (para enseñarlo mientras el actual aún tiene pocos km)
  const lastClosed = list.find(r => r.l100 != null);
  const prev_tank0 = lastClosed ? { km: lastClosed.km, l100: lastClosed.l100, litres: lastClosed.litres, full: !!lastClosed.full_to_full,
    eur_km: lastClosed.price_total && lastClosed.km ? round(lastClosed.price_total / lastClosed.km, 3) : null } : null;
  const prev_tank = prev_tank0;
  // Recién repostado: la autonomía se calcula con el consumo del depósito anterior
  if (tank && tank.range_km == null && prev_tank && prev_tank.l100) { tank.range_km = Math.round(tank.left_l / prev_tank.l100 * 100); tank.range_from_prev = true; }
  return { refuels: list, avg_l100: totalKm ? round((totalUsed / totalKm) * 100, 1) : null, tank_l: TANK_L, tank, prev_tank };
}

// Calibra el aforador: litros reales del repostaje frente a lo que marcó el depósito desde el anterior lleno
async function calibrateFuel(env, ts, litres) {
  const prev = await env.DB.prepare('SELECT ts, fuel_after FROM refuels WHERE ts < ? ORDER BY ts DESC LIMIT 1').bind(ts).first();
  const cur = await env.DB.prepare('SELECT fuel_before, fuel_after FROM refuels WHERE ts = ?').bind(ts).first();
  if (!prev || !cur || cur.fuel_before == null || cur.fuel_after < 95 || prev.fuel_after < 95) return null;
  const gauge = ((prev.fuel_after - cur.fuel_before) / 100) * TANK_L;
  if (gauge < 10) return null;
  const f = Math.min(1.25, Math.max(0.75, litres / gauge));
  const old = await env.DB.prepare("SELECT v FROM kv WHERE k = 'fuel_factor'").first();
  const nf = old ? round(Number(old.v) * 0.5 + f * 0.5, 3) : round(f, 3);
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('fuel_factor', ?)").bind(String(nf)).run();
  return nf;
}

async function updateRefuel(env, ts, body) {
  if (body.litres != null && body.litres !== '') {
    const l = Number(String(body.litres).replace(',', '.'));
    if (!(l > 1 && l <= TANK_L + 2)) throw httpError('Los litros no son válidos', 400);
    await env.DB.prepare('UPDATE refuels SET litres = ? WHERE ts = ?').bind(l, ts).run();
    await calibrateFuel(env, ts, l);
  }
  const price = body.price_total === null || body.price_total === '' ? null : Number(body.price_total);
  if (price !== null && !(price > 0 && price < 1000)) throw httpError('El precio no es válido', 400);
  const station = body.station ? String(body.station).slice(0, 80) : null;
  if (body.price_l != null && body.price_l !== '') {
    const pl = Number(String(body.price_l).replace(',', '.'));
    if (pl > 0.5 && pl < 4) await env.DB.prepare('UPDATE refuels SET price_l = ? WHERE ts = ?').bind(pl, ts).run();
  }
  const r = await env.DB.prepare('UPDATE refuels SET price_total = ?, station = ?, price_auto = 0 WHERE ts = ?').bind(price, station, ts).run();
  if (!r.meta.changes) throw httpError('Repostaje no encontrado', 404);
  return { ok: true };
}

// ---------- Foto del surtidor: la IA lee litros, €/L y total ----------
const PUMP_PROMPT = 'Esta foto es la pantalla de un surtidor de gasolina en España. Lee los tres números: importe total en euros, litros y precio por litro. ' +
  'Responde SOLO con JSON así: {"total": 58.18, "litres": 41.0, "price_l": 1.419}. Usa punto decimal. Si no ves un número, pon null.';

async function readPump(env, body) {
  const img = String(body.image || '');
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(img) || img.length > 4e6) throw httpError('La foto no es válida', 400);
  if (!env.AI) throw httpError('El lector de fotos no está activo', 503);
  let txt = null;
  for (const model of ['@cf/meta/llama-4-scout-17b-16e-instruct', '@cf/google/gemma-4-26b-a4b-it']) {
    try {
      const out = await env.AI.run(model, {
        messages: [{ role: 'user', content: [{ type: 'text', text: PUMP_PROMPT }, { type: 'image_url', image_url: { url: img } }] }],
        max_tokens: 300, temperature: 0
      });
      const r = out?.response ?? out?.choices?.[0]?.message?.content ?? out;
      txt = typeof r === 'string' ? r : JSON.stringify(r);
      if (/\d/.test(txt)) break;
    } catch (e) { console.error('ai ' + model, e); }
  }
  if (!txt) throw httpError('No he podido leer la foto, prueba otra vez', 502);
  const m = txt.match(/\{[^{}]*\}/);
  let v = {};
  try { v = JSON.parse(m ? m[0] : '{}'); } catch (e) {}
  const n = x => { const k = Number(String(x ?? '').replace(',', '.')); return k > 0 ? k : null; };
  let total = n(v.total), litres = n(v.litres), price_l = n(v.price_l);
  // Completa el que falte y corrige si uno no cuadra con los otros dos
  if (!total && litres && price_l) total = round(litres * price_l, 2);
  if (!litres && total && price_l) litres = round(total / price_l, 2);
  if (!price_l && total && litres) price_l = round(total / litres, 3);
  if (price_l && (price_l < 0.8 || price_l > 3)) price_l = total && litres ? round(total / litres, 3) : null;
  if (litres && litres > TANK_L + 2) litres = null;
  const ok = total && litres && price_l && Math.abs(litres * price_l - total) <= Math.max(0.15, total * 0.01);
  return { total, litres, price_l, ok: !!ok };
}

async function applyPump(env, ts, v) {
  if (v.photo && env.BACKUPS) {
    await env.BACKUPS.put('foto-' + ts, v.photo, { expirationTtl: 400 * 86400 });
    if (v.photoKey) await env.BACKUPS.delete(v.photoKey);
  } else if (v.photoKey && env.BACKUPS) {
    const ph = await env.BACKUPS.get(v.photoKey);
    if (ph) { await env.BACKUPS.put('foto-' + ts, ph, { expirationTtl: 400 * 86400 }); await env.BACKUPS.delete(v.photoKey); }
  }
  const hasPhoto = !!(v.photo || v.photoKey);
  await updateRefuel(env, ts, { litres: v.litres, price_total: v.total, price_l: v.price_l, station: v.station || await favName(env) });
  if (hasPhoto) await env.DB.prepare('UPDATE refuels SET photo = 1 WHERE ts = ?').bind(ts).run();
}

// Guarda lo leído: en el repostaje indicado, en el último si es de hace menos de 12 h, o pendiente hasta que el coche lo detecte
async function savePump(env, body) {
  const v = { litres: Number(body.litres), total: Number(body.total), price_l: Number(body.price_l), station: body.station || null };
  if (!(v.litres > 1 && v.litres <= TANK_L + 2) || !(v.total > 0 && v.total < 300) || !(v.price_l > 0.5 && v.price_l < 4)) throw httpError('Revisa los números', 400);
  const photo = /^data:image\/jpeg;base64,/.test(String(body.image || '')) && body.image.length < 4e6 ? body.image : null;
  let ts = Number(body.ts) || null;
  if (!ts) {
    const last = await env.DB.prepare('SELECT ts FROM refuels ORDER BY ts DESC LIMIT 1').first();
    if (last && Date.now() - last.ts < 12 * 3600e3) ts = last.ts;
  }
  if (ts) { await applyPump(env, ts, { ...v, photo }); return { ok: true, ts }; }
  const now = Date.now();
  let photoKey = null;
  if (photo && env.BACKUPS) { photoKey = 'foto-pend-' + now; await env.BACKUPS.put(photoKey, photo, { expirationTtl: 3 * 86400 }); }
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('pending_pump', ?)").bind(JSON.stringify({ ...v, ts: now, photoKey })).run();
  return { ok: true, pending: true };
}

async function favName(env) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'fav_station'").first();
  try { if (!row) return null; const f = JSON.parse(row.v); return [titleCase(f.name || ''), titleCase(f.town || '')].filter(Boolean).join(' ') || null; } catch (e) { return null; }
}

async function pumpPhoto(env, ts) {
  const ph = env.BACKUPS && await env.BACKUPS.get('foto-' + ts);
  if (!ph) throw httpError('Sin foto', 404);
  const [, b64] = ph.split(',');
  const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return new Response(bin, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=86400', 'access-control-allow-origin': '*' } });
}

// ---------- Preparar un día de circuito (antes) y revisar después ----------
async function trackPrep(env) {
  const [ts, maint, car, td] = await Promise.all([getTyreSet(env), listMaint(env), getLive(env), trackDays(env).catch(() => ({ days: [] }))]);
  const before = [], after = [];
  const add = (arr, k, title, text) => arr.push({ k, title, text });
  // Neumáticos: dibujo y hombros
  const L = ts.tread_last;
  if (L) {
    const zm = z => z == null ? null : typeof z === 'number' ? z : Math.min(...[z.o, z.c, z.i].filter(v => v != null));
    const min = Math.min(...['fl', 'fr', 'rl', 'rr'].map(k => zm(L[k])).filter(v => v != null));
    const since = car.odometer_km != null ? car.odometer_km - L.km : 0;
    const now = ts.tread_rate ? round(min - ts.tread_rate * since / 1000, 1) : min;
    add(before, now >= 4 ? 'ok' : now >= 3 ? 'w' : 'x', 'Dibujo', now >= 4 ? `≈${fmt(now, 1)} mm en la rueda más gastada: bien para pista.` : now >= 3 ? `≈${fmt(now, 1)} mm: vale para seco, pero en pista se calientan más y bajan rápido. Si llueve, mejor no.` : `≈${fmt(now, 1)} mm: muy justas para circuito. Cámbialas antes.`);
  } else add(before, 'i', 'Dibujo', 'Mide el dibujo (Taller → Medir dibujo) para saber si aguantan el día.');
  if (ts.rotate_in_km != null && ts.rotate_in_km < 1500) add(before, 'i', 'Permuta', `La permuta toca en ${fmt(Math.max(0, ts.rotate_in_km))} km: hazla antes de ir y llegas con las cuatro igual.`);
  // Presiones
  const ref = car.tyre_ref || {};
  add(before, 'i', 'Presiones', `Sal con tus presiones en frío (${fmt(ref.fl ?? 2.2, 1)} delante / ${fmt(ref.rl ?? 2.1, 1)} detrás). En pista suben 0,3–0,5 bar: mídelas nada más entrar a boxes y, si pasan de ~2,5 en caliente, quita aire hasta dejarlas ahí. Apunta lo que quitas para la próxima vez.`);
  // Frenos
  const fluid = maint.items.find(i => /l[ií]quido de frenos/i.test(i.name));
  if (fluid && fluid.last_date) {
    const months = (Date.now() - Date.parse(fluid.last_date)) / (30.4 * 86400e3);
    add(before, months <= 12 ? 'ok' : 'w', 'Líquido de frenos', months <= 12 ? `Cambiado hace ${Math.round(months)} meses: bien.` : `Cambiado hace ${Math.round(months)} meses. Con calor de pista el líquido viejo hierve y el pedal se va al fondo: purga o cámbialo (DOT 4 de alto punto de ebullición) antes de ir.`);
  } else add(before, 'w', 'Líquido de frenos', 'No sé cuándo se cambió. En pista es lo primero que falla (el pedal se va al fondo): si no lo recuerdas, cámbialo antes de ir y apúntalo en Taller.');
  const pads = maint.items.find(i => /pastilla/i.test(i.name));
  if (pads && pads.rem_km != null) add(before, pads.rem_km > 3000 ? 'ok' : 'w', 'Pastillas', pads.rem_km > 3000 ? `Según el cálculo les quedan ~${fmt(pads.rem_km)} km (en pista gastan 5 veces más): mira el grosor igualmente.` : `Les quedan poco (~${fmt(Math.max(0, pads.rem_km))} km de calle; en pista se gastan 5 veces más). Revísalas antes de ir.`);
  else add(before, 'i', 'Pastillas', 'Mira el grosor por los radios de la llanta (mínimo ~3 mm de material). En pista se gastan unas 5 veces más que en calle.');
  // Aceite y motor
  const oil = car.oil_life_pct;
  add(before, oil == null ? 'i' : oil >= 30 ? 'ok' : 'w', 'Aceite', `${oil != null ? `Vida del aceite ${oil} %. ` : ''}Comprueba el nivel con la varilla en llano y en frío: en pista el motor gasta algo de aceite y en curvas largas un nivel bajo puede dejar sin presión.${oil != null && oil < 30 ? ' Con tan poca vida, mejor cambiarlo antes.' : ''}`);
  // Gasolina
  const fuelL = car.fuel_pct != null ? car.fuel_pct / 100 * TANK_L : null;
  add(before, 'i', 'Gasolina', `En pista el ST gasta unos 25–30 l/100: una tanda de 20 vueltas en Albacete son ~20 L. ${fuelL != null ? `Ahora llevas ~${fmt(fuelL, 0)} L. ` : ''}Ve con el depósito lleno y mira dónde repostar cerca del circuito.`);
  // Después: según el último día de circuito
  const last = (td.days || [])[0];
  const extraKm = ts.track_extra_km || 0;
  const lapsInfo = last ? `${fmt(last.km, 0)} km en ${last.circuit} el ${last.day}` : extraKm ? `${fmt(extraKm, 0)} km de circuito apuntados` : null;
  if (lapsInfo) add(after, 'i', 'Tu último día', lapsInfo + '.');
  add(after, 'i', 'Tornillos de rueda', 'Repasa el apriete de los tornillos con la llave dinamométrica al par del manual: con el calor de los frenos pueden aflojarse.');
  add(after, 'i', 'Presiones', 'Al día siguiente, en frío, vuelve a dejarlas a tus presiones de diario (si quitaste aire en pista, se quedarán bajas).');
  add(after, 'i', 'Neumáticos', 'Mide el dibujo en las tres zonas: verás cuánto se ha comido el hombro. Mira también que no haya goma levantada o "granos" (graining).');
  add(after, 'i', 'Frenos', 'Si el pedal estuvo largo o los frenos olían mucho, purga el líquido. Mira el grosor de las pastillas y que los discos no tengan grietas.');
  add(after, 'i', 'Aceite', 'Vuelve a mirar el nivel: si ha bajado, rellena con el mismo aceite.');
  return { before, after };
}

// ---------- Tu coche: nombre, modelo y depósito (para que la app valga para cualquier Ford conectado) ----------
async function carConfig(env) {
  const r = await env.DB.prepare("SELECT v FROM kv WHERE k = 'car_cfg'").first();
  const o = r ? JSON.parse(r.v) : {};
  return { name: o.name || '', model: o.model || '', tank_l: o.tank_l || TANK_L };
}
async function setCarConfig(env, b) {
  const cur = await carConfig(env);
  const t = Number(String(b.tank_l ?? '').replace(',', '.'));
  const o = {
    name: String(b.name ?? cur.name).trim().slice(0, 20),
    model: String(b.model ?? cur.model).trim().slice(0, 40),
    tank_l: t > 20 && t < 150 ? Math.round(t) : cur.tank_l
  };
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('car_cfg', ?)").bind(JSON.stringify(o)).run();
  TANK_L = o.tank_l;
  return o;
}

// ---------- Siri: "¿Cómo está el coche?" ----------
async function siriText(env) {
  const c = await getLive(env);
  const places = await getPlaces(env);
  const running = c.ignition && c.ignition !== 'off';
  const out = [];
  if (running) out.push(`El coche está en marcha${c.speed_kmh ? ' a ' + c.speed_kmh + ' kilómetros por hora' : ''}.`);
  else {
    const where = c.location ? placeAt(c.location.lat, c.location.lon, places) || await geoName(env, c.location.lat, c.location.lon) : null;
    const open = [...(c.doors_open || []), ...(c.windows_open || [])];
    out.push(c.locked === false ? `Ojo: el coche está abierto${where ? ' en ' + where : ''}.` : `El coche está cerrado${where ? ' en ' + where : ''}.`);
    if (open.length) out.push('Abierto: ' + open.join(', ') + '.');
  }
  if (c.fuel_pct != null) out.push(`Gasolina al ${Math.round(c.fuel_pct)} por ciento${c.range_km ? ', unos ' + c.range_km + ' kilómetros' : ''}.`);
  if (c.tyres) {
    const low = c.tyres_low || [];
    out.push(low.length ? `Revisa la presión: ${low.map(k => ({ fl: 'delantera izquierda', fr: 'delantera derecha', rl: 'trasera izquierda', rr: 'trasera derecha' })[k] || k).join(' y ')}.` : 'Las ruedas están bien.');
  }
  if (!running) {
    if (c.battery_v != null) out.push(c.battery_v >= 12.4 ? 'Batería correcta.' : `Batería baja, a ${String(c.battery_v).replace('.', ',')} voltios.`);
    else if (c.battery_soc != null) out.push(c.battery_soc >= 70 ? 'Batería correcta.' : `Batería al ${c.battery_soc} por ciento.`);
  }
  if (c.fuel_pct != null && c.fuel_pct < 30) {
    const a = await refuelAdvice(env).catch(() => null);
    if (a && a.short) out.push(a.short);
  }
  return out.join(' ');
}

// ---------- Histórico de precios de tu gasolinera (Ministerio, día a día) y consejo de repostaje ----------
const FUEL_HIST_API = 'https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestresHist/FiltroProvincia/';
async function priceHistBackfill(env) {
  const fr = await env.DB.prepare("SELECT v FROM kv WHERE k = 'fav_station'").first();
  if (!fr) return;
  const f = JSON.parse(fr.v);
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'fav_prices'").first();
  const hist = row ? JSON.parse(row.v) : [];
  const have = new Set(hist.filter(h => h.id == null || h.id === f.id).map(h => h.d));
  const tried = await env.DB.prepare("SELECT v FROM kv WHERE k = 'fav_hist_tried'").first();
  const skip = new Set(tried ? JSON.parse(tried.v) : []);
  const waitRow = await env.DB.prepare("SELECT v FROM kv WHERE k = 'fav_hist_wait'").first();
  const waiting = waitRow && Date.now() - Number(waitRow.v) < 3600e3;
  let day = null;
  for (let i = 1; i <= 90; i++) {
    if (waiting && i <= 2) continue;
    const d = new Date(Date.now() + 3600e3 - i * 86400e3).toISOString().slice(0, 10);
    if (!have.has(d) && !skip.has(f.id + d)) { day = d; break; }
  }
  if (!day) return;
  const [y, mo, dd] = day.split('-');
  let p95 = null, p98 = null, avg95 = null;
  try {
    const r = await fetch(FUEL_HIST_API + `${dd}-${mo}-${y}/${f.prov}`, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (FiestaSTGaraje)' } });
    if (r.ok) {
      const j = await r.json();
      const n = v => { const x = parseFloat(String(v || '').replace(',', '.')); return isNaN(x) ? null : x; };
      const L = j.ListaEESSPrecio || [];
      const s = L.find(x => x.IDEESS === f.id);
      if (s) { p95 = n(s[FUEL_FIELDS['95']]); p98 = n(s[FUEL_FIELDS['98']]); }
      const all = L.map(x => n(x[FUEL_FIELDS['95']])).filter(Boolean).sort((a, b) => a - b);
      if (all.length) avg95 = all[Math.floor(all.length / 2)];
    }
  } catch (e) { /* se reintenta otro día */ }
  if (p95 == null && p98 == null) {
    // Los últimos 2 días puede que aún no estén publicados: no se marcan, se reintentan otro rato
    if (Date.now() - Date.parse(day + 'T00:00:00Z') < 3 * 86400e3) { await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('fav_hist_wait', ?)").bind(String(Date.now())).run(); return; }
    skip.add(f.id + day);
    await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('fav_hist_tried', ?)").bind(JSON.stringify([...skip].slice(-200))).run();
    return;
  }
  hist.push({ d: day, id: f.id, p95, p98, med95: avg95 });
  hist.sort((a, b) => a.d < b.d ? -1 : 1);
  while (hist.length > 180) hist.shift();
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('fav_prices', ?)").bind(JSON.stringify(hist)).run();
}

const DIAS = ['domingos', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados'];
async function refuelAdvice(env) {
  const type = await userFuelType(env);
  const fav = await favStation(env, type).catch(() => null);
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'fav_prices'").first();
  const hist = (row ? JSON.parse(row.v) : []).filter(h => h['p' + type] != null && (!fav || h.id == null || h.id === fav.id));
  const key = 'p' + type;
  const today = fav && !fav.missing ? fav.price : (hist.length ? hist[hist.length - 1][key] : null);
  if (today == null || hist.length < 10) return { ready: false, days: hist.length, today, station: fav ? `${fav.name} ${titleCase(fav.town)}` : null };
  const last30 = hist.slice(-30).map(h => h[key]);
  const mean = last30.reduce((a, b) => a + b, 0) / last30.length;
  const min = Math.min(...last30), max = Math.max(...last30);
  // Patrón por día de la semana: diferencia con la media de su semana (quita la tendencia)
  const dev = Array.from({ length: 7 }, () => []);
  hist.forEach((h, i) => {
    const win = hist.slice(Math.max(0, i - 3), i + 4).map(x => x[key]);
    const m = win.reduce((a, b) => a + b, 0) / win.length;
    dev[new Date(h.d + 'T12:00:00Z').getUTCDay()].push(h[key] - m);
  });
  const wd = dev.map((a, i) => ({ i, n: a.length, v: a.length ? a.reduce((x, y) => x + y, 0) / a.length : null })).filter(x => x.n >= 3);
  const best = wd.length >= 5 ? wd.reduce((a, b) => (b.v < a.v ? b : a)) : null;
  const worst = wd.length >= 5 ? wd.reduce((a, b) => (b.v > a.v ? b : a)) : null;
  const pattern = best && worst && worst.v - best.v >= 0.006 ? { best: DIAS[best.i], best_cts: round(-best.v * 100, 1), worst: DIAS[worst.i], worst_cts: round(worst.v * 100, 1) } : null;
  // Tendencia: últimos 7 días
  const l7 = hist.slice(-7).map(h => h[key]);
  const trend = l7.length >= 5 ? round((l7[l7.length - 1] - l7[0]) * 100, 1) : null;
  const diff = round((today - mean) * 100, 1); // céntimos sobre la media
  const todayIdx = new Date(Date.now() + 3600e3).getUTCDay();
  let verdict, short;
  const min90 = Math.min(...hist.map(h => h[key]));
  const tr30 = round((today - last30[0]) * 100, 0);
  if (today <= min + 0.002 || diff <= -1) { verdict = 'llena'; short = `Hoy está ${fmt(-diff, 1)} céntimos por debajo de su media${today <= min90 + 0.001 ? ', el precio más bajo de los últimos 3 meses' : ''}: buen día para llenar.${tr30 <= -5 ? ` Lleva semanas bajando (${fmt(tr30, 0)} cts en un mes), pero esperar es apostar.` : ''}`; }
  else if (diff >= 1.5) { verdict = 'espera'; short = `Hoy está ${fmt(diff, 1)} céntimos por encima de su media${pattern ? `; suele estar más barata los ${pattern.best}` : ''}. Si puedes, pon lo justo y llena luego.`; }
  else { verdict = 'normal'; short = pattern && pattern.best !== DIAS[todayIdx] ? `Precio normal hoy; los ${pattern.best} suele estar ${fmt(pattern.best_cts, 1)} céntimos más barata.` : 'Precio normal hoy.'; }
  const pts = hist.length;
  return { ready: true, today, mean: round(mean, 3), min, max, diff_cts: diff, trend_cts: trend, pattern, verdict, short, days: pts,
    station: fav ? `${fav.name} ${titleCase(fav.town)}` : null, fill_eur: round(today * TANK_L, 0) };
}

// ---------- Resumen de un mes ----------
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
async function monthStats(env, ym) {
  const [y, m] = ym.split('-').map(Number);
  const a = Date.UTC(y, m - 1, 1) - 3600e3, b = Date.UTC(y, m, 1) - 3600e3;
  const t = await env.DB.prepare('SELECT COUNT(*) n, SUM(km) km, SUM(duration_s) s, SUM(fuel_used_l) l, MAX(max_speed) vmax, SUM(CASE WHEN track = 1 THEN 1 ELSE 0 END) track FROM trips WHERE start_ts >= ? AND start_ts < ?').bind(a, b).first();
  const r = await env.DB.prepare('SELECT COUNT(*) n, SUM(litres) l, SUM(price_total) eur FROM refuels WHERE ts >= ? AND ts < ?').bind(a, b).first();
  const e = (await rawExpenses(env)).filter(x => x.date && x.date.slice(0, 7) === ym).reduce((s, x) => s + (x.eur || 0), 0);
  return { ym, label: MESES[m - 1] + ' ' + y, trips: t.n || 0, km: round(t.km || 0, 0), hours: round((t.s || 0) / 3600, 1), fuel_l: round(t.l || 0, 1),
    l100: t.km > 50 ? round(t.l / t.km * 100, 1) : null, vmax: t.vmax, track: t.track || 0, refuels: r.n || 0, refuel_l: round(r.l || 0, 1), fuel_eur: round(r.eur || 0, 2), other_eur: round(e, 2) };
}
async function monthSummary(env, ym) {
  const now = new Date(Date.now() + 3600e3);
  ym = /^\d{4}-\d{2}$/.test(ym || '') ? ym : now.toISOString().slice(0, 7);
  const [y, m] = ym.split('-').map(Number);
  const prevYm = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
  const cur = await monthStats(env, ym), prev = await monthStats(env, prevYm);
  // Ida y vuelta al trabajo este mes
  const places = await getPlaces(env);
  const [ta, tb] = [Date.UTC(y, m - 1, 1) - 3600e3, Date.UTC(y, m, 1) - 3600e3];
  const { results } = await env.DB.prepare('SELECT points, km, fuel_used_l FROM trips WHERE start_ts >= ? AND start_ts < ?').bind(ta, tb).all();
  const price = await priceFinder(env);
  let wN = 0, wKm = 0, wL = 0;
  for (const t of results) {
    const pl = tripPlaces(JSON.parse(t.points || '[]'), places);
    if ([pl.from, pl.to].some(x => /trabajo|oficina/i.test(x || ''))) { wN++; wKm += t.km || 0; wL += t.fuel_used_l || 0; }
  }
  const work = wN ? { trips: wN, km: round(wKm, 0), eur: round(wL * price(Date.now()), 2) } : null;
  const pct = (a, b) => b ? Math.round((a - b) / b * 100) : null;
  const parts = [`${fmt(cur.km)} km en ${cur.trips} trayectos`];
  if (cur.l100) parts.push(`${fmt(cur.l100, 1)} l/100`);
  if (cur.fuel_eur) parts.push(`${fmt(cur.fuel_eur, 2)} € en gasolina`);
  if (work) parts.push(`al trabajo ${work.trips} viajes (${fmt(work.eur, 2)} €)`);
  if (prev.km) { const d = pct(cur.km, prev.km); parts.push(`${d >= 0 ? '+' : ''}${d} % km que en ${prev.label.split(' ')[0]}`); }
  return { ...cur, prev, work, km_vs_prev_pct: pct(cur.km, prev.km), text: parts.join(' · ') + '.' };
}

// ---------- Comparar con trayectos iguales (misma salida y llegada, ±400 m) ----------
async function sameTrips(env, t, pts) {
  if (!pts.length || t.track) return null;
  const a = pts[0], b = pts[pts.length - 1];
  if (distKm(a[0], a[1], b[0], b[1]) < 1) return null;
  const { results } = await env.DB.prepare('SELECT id, start_ts, km, duration_s, fuel_used_l, start_lat, start_lon, end_lat, end_lon FROM trips WHERE id != ? AND COALESCE(track, 0) = 0 AND start_lat IS NOT NULL AND end_lat IS NOT NULL').bind(t.id).all();
  const same = results.filter(o => distKm(a[0], a[1], o.start_lat, o.start_lon) < 0.4 && distKm(b[0], b[1], o.end_lat, o.end_lon) < 0.4 && o.km > t.km * 0.7 && o.km < t.km * 1.4);
  if (!same.length) return null;
  const all = [...same, t];
  const avgS = same.reduce((s, o) => s + o.duration_s, 0) / same.length;
  const best = all.reduce((x, y) => (y.duration_s < x.duration_s ? y : x));
  const lOk = same.filter(o => o.fuel_used_l && o.km >= 5);
  const avgL = lOk.length ? lOk.reduce((s, o) => s + o.fuel_used_l / o.km * 100, 0) / lOk.length : null;
  const rank = all.filter(o => o.duration_s < t.duration_s).length + 1;
  return { n: same.length, avg_s: Math.round(avgS), diff_s: Math.round(t.duration_s - avgS), best_s: best.duration_s, best_id: best.id, best_ts: best.start_ts,
    is_best: best.id === t.id, rank, of: all.length, avg_l100: avgL != null ? round(avgL, 1) : null,
    l100: t.fuel_used_l && t.km >= 5 ? round(t.fuel_used_l / t.km * 100, 1) : null };
}

// ---------- Salud y uso del motor ----------
async function engineStats(env, days) {
  const since = Date.now() - days * 86400e3;
  const { results: trips } = await env.DB.prepare('SELECT id, start_ts, end_ts, km, duration_s, max_rpm, max_oil, track FROM trips WHERE start_ts >= ? ORDER BY start_ts').bind(since).all();
  const { results: snaps } = await env.DB.prepare("SELECT data FROM snapshots WHERE ts >= ? AND json_extract(data, '$.ignition') != 'off' ORDER BY ts").bind(since - 3600e3).all();
  const seen = new Set(), S = [];
  for (const r of snaps) {
    let c; try { c = JSON.parse(r.data); } catch (e) { continue; }
    const k = c.data_ts || c.ts; if (seen.has(k)) continue; seen.add(k);
    const trip = trips.find(t => k >= t.start_ts - 60e3 && k <= t.end_ts + 60e3);
    if (!trip) continue;
    S.push({ ts: k, trip, spd: c.speed_kmh || 0, rpm: c.rpm || 0, temp: c.oil_c ?? c.coolant_c ?? null, bat: c.battery_v, gear: gearFrom(c.speed_kmh, c.rpm) });
  }
  const live = S.filter(p => p.rpm > 0);
  // Tiempo en cada franja de vueltas (cada lectura vale lo mismo: llegan cada ~2 min)
  const BANDS = [[0, 1100, 'Ralentí'], [1100, 2000, '1.100–2.000'], [2000, 2500, '2.000–2.500'], [2500, 3000, '2.500–3.000'], [3000, 4000, '3.000–4.000'], [4000, 5000, '4.000–5.000'], [5000, 9000, '+5.000']];
  const rpmBands = BANDS.map(([a, b, l]) => ({ label: l, n: live.filter(p => p.rpm >= a && p.rpm < b).length }));
  const gears = [1, 2, 3, 4, 5, 6].map(g => ({ gear: g, n: live.filter(p => p.gear === g).length }));
  const scatter = live.filter(p => p.spd > 0).slice(-500).map(p => [p.spd, p.rpm, p.gear || 0]);
  // Por trayecto: calentamiento, temperatura máxima, alternador, revoluciones en frío
  const per = trips.map(t => {
    const ps = S.filter(p => p.trip === t);
    const w = ps.find(p => p.temp != null && p.temp >= OIL_WARM);
    const temps = ps.map(p => p.temp).filter(v => v != null);
    const alt = ps.filter(p => p.rpm > 1500 && p.bat).map(p => p.bat);
    const cold = ps.filter(p => p.temp != null && p.temp < 70 && p.rpm > 3000);
    return { id: t.id, ts: t.start_ts, km: t.km, track: !!t.track, n: ps.length,
      warm_min: w ? Math.max(0, Math.round((w.ts - t.start_ts) / 60e3)) : null,
      reached: temps.length ? Math.max(...temps, t.max_oil || 0) >= OIL_WARM : (t.max_oil || 0) >= OIL_WARM,
      cold_start: temps.length ? temps[0] < 40 : null, max_temp: Math.max(t.max_oil || 0, ...temps, 0) || null,
      alt_v: alt.length ? r2(alt.reduce((a, b) => a + b, 0) / alt.length) : null, cold_revs: cold.length ? Math.max(...cold.map(p => p.rpm)) : null };
  });
  const road = per.filter(p => !p.track);
  const short = road.filter(p => !p.reached);
  const coldRev = road.filter(p => p.cold_revs);
  const hot = per.filter(p => p.max_temp != null && p.max_temp >= 108);
  const altS = per.filter(p => p.alt_v != null);
  const altAvg = altS.length ? r2(altS.reduce((a, p) => a + p.alt_v, 0) / altS.length) : null;
  const altLow = altAvg != null && altAvg < 13.5;
  // Nota de cuidado del motor
  let score = 100; const tips = [];
  if (road.length) {
    const sp = short.length / road.length, cp = coldRev.length / road.length;
    if (sp > 0.25) { score -= Math.min(25, Math.round((sp - 0.25) * 60)); tips.push({ k: 'w', t: `${Math.round(sp * 100)} % de trayectos sin llegar a temperatura: el aceite no se calienta del todo y acumula humedad y gasolina. Haz al menos un trayecto de 20 min seguidos a la semana.` }); }
    else tips.push({ k: 'ok', t: `Casi todos tus trayectos llegan a temperatura (${Math.round((1 - sp) * 100)} %).` });
    if (coldRev.length) { score -= Math.min(30, Math.round(cp * 80) + 5); tips.push({ k: 'w', t: `${coldRev.length} trayecto${coldRev.length > 1 ? 's' : ''} con más de 3.000 rpm en frío (máx. ${fmt(Math.max(...coldRev.map(p => p.cold_revs)))} rpm). El turbo y el aceite sufren: espera a ${OIL_WARM}° antes de apretar.` }); }
    else tips.push({ k: 'ok', t: 'Nunca lo has subido de vueltas en frío. 👌' });
  }
  if (hot.length) { score -= Math.min(30, hot.length * 15); tips.push({ k: 'x', t: `${hot.length} vez${hot.length > 1 ? 'es' : ''} la temperatura pasó de 108 °C. Revisa el nivel de refrigerante y que el electroventilador funcione.` }); }
  if (altLow) { score -= 10; tips.push({ k: 'w', t: `En marcha la tensión media es ${fmt(altAvg, 2)} V (lo normal: 13,8–14,7 V). Puede que el alternador o la batería empiecen a flojear.` }); }
  else if (altAvg != null) tips.push({ k: 'ok', t: `El alternador carga bien (${fmt(altAvg, 2)} V de media en marcha).` });
  score = Math.max(0, Math.min(100, score));
  // Vida del aceite por km (todo el histórico)
  const { results: oilR } = await env.DB.prepare("SELECT json_extract(data,'$.oil_life_pct') o, MIN(odometer) km, MIN(ts) ts FROM snapshots WHERE json_extract(data,'$.oil_life_pct') IS NOT NULL GROUP BY o ORDER BY km").all();
  const oRate = await oilRate(env);
  const kpd = await kmPerDay(env);
  const lastOil = oilR.length ? oilR[oilR.length - 1] : null;
  const odo = await currentOdo(env);
  let oilEta = null;
  if (lastOil && oRate && kpd > 1) { const left = Math.max(0, lastOil.o * oRate - (odo - lastOil.km)); oilEta = { km: Math.round(left), date: etaDate(left / kpd) }; }
  // Récords
  const allMax = await env.DB.prepare('SELECT MAX(max_rpm) r, MAX(max_oil) t FROM trips').first();
  const cruise = live.filter(p => p.spd >= 110 && p.spd <= 125);
  const total_s = trips.reduce((a, t) => a + (t.duration_s || 0), 0);
  const month0 = new Date(Date.now() + 3600e3); month0.setUTCDate(1); month0.setUTCHours(0, 0, 0, 0);
  return {
    days, samples: live.length, trips: per.length, score, tips,
    rpm_bands: rpmBands, gears, gear_ratios: GEAR_KMH_PER_1000, scatter,
    warm: per.filter(p => p.warm_min != null || !p.reached).map(p => ({ id: p.id, ts: p.ts, min: p.warm_min, reached: p.reached, km: p.km })),
    max_temp_trips: per.map(p => ({ id: p.id, ts: p.ts, t: p.max_temp })).filter(p => p.t),
    alternator: altS.map(p => ({ ts: p.ts, v: p.alt_v })), alt_avg: altAvg,
    oil: oilR.map(r => ({ km: r.km, ts: r.ts, pct: r.o })), oil_rate: oRate, oil_eta: oilEta,
    records: {
      max_rpm: allMax.r, max_temp: allMax.t,
      over4000_min: Math.round(live.filter(p => p.rpm >= 4000).length / Math.max(1, live.length) * total_s / 60),
      cruise_rpm: cruise.length ? Math.round(cruise.reduce((a, p) => a + p.rpm, 0) / cruise.length) : null,
      cold_starts_month: per.filter(p => p.cold_start && p.ts >= month0.getTime() - 3600e3).length,
      short_pct: road.length ? Math.round(short.length / road.length * 100) : null
    }
  };
}

async function listTrips(env, limit) {
  const { results } = await env.DB.prepare(
    `SELECT id, start_ts, end_ts, km, duration_s, avg_speed, max_speed, max_rpm, max_oil, avg_throttle, rpm_high_pct, fuel_used_l,
     track, circuit, points FROM trips ORDER BY start_ts DESC LIMIT ?`
  ).bind(limit).all();
  const price = await priceFinder(env);
  const places = await getPlaces(env);
  const parsed = results.map(r => JSON.parse(r.points || '[]'));
  const gc = await geoCached(env, parsed.flatMap(pp => pp.length ? [pp[0], pp[pp.length - 1]] : []));
  return {
    places,
    commute: commuteStats(results, places, price),
    trips: results.map(({ points, ...t }, i) => {
      const pp = parsed[i];
      Object.assign(t, tripPlaces(pp, places));
      if (pp.length && !t.circuit) {
        const a = pp[0], b = pp[pp.length - 1];
        if (!t.from) t.from = gc[geoKey(a[0], a[1])] || null;
        if (!t.to) t.to = gc[geoKey(b[0], b[1])] || null;
      }
      const sp = pp.map(p => p[2]);
      const n = 16, spark = [];
      if (sp.length > 1) for (let i = 0; i < n; i++) spark.push(sp[Math.round(i * (sp.length - 1) / (n - 1))]);
      return { ...t, spark, cost_eur: t.fuel_used_l != null ? round(t.fuel_used_l * price(t.start_ts), 2) : null };
    })
  };
}

async function getTrip(env, id) {
  const t = await env.DB.prepare('SELECT * FROM trips WHERE id = ?').bind(id).first();
  if (!t) throw httpError('Trayecto no encontrado', 404);
  let route = null;
  if (t.start_lat != null && t.end_lat != null) {
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS n, AVG(duration_s) AS dur, MIN(duration_s) AS best, AVG(avg_speed) AS spd,
        SUM(fuel_used_l) AS fuel, SUM(km) AS km FROM trips
       WHERE id != ? AND COALESCE(track, 0) = 0 AND round(start_lat, 2) = round(?, 2) AND round(start_lon, 2) = round(?, 2)
         AND round(end_lat, 2) = round(?, 2) AND round(end_lon, 2) = round(?, 2)`
    ).bind(id, t.start_lat, t.start_lon, t.end_lat, t.end_lon).first();
    if (r && r.n) route = { count: r.n, avg_duration_s: Math.round(r.dur), best_duration_s: r.best, avg_speed: Math.round(r.spd), avg_l100: r.km ? round(r.fuel / r.km * 100, 1) : null };
  }
  const price = await priceFinder(env);
  if (route) route.avg_cost_eur = r2(route.avg_l100 != null ? route.avg_l100 / 100 * t.km * price(t.start_ts) : null);
  const pts0 = JSON.parse(t.points || '[]');
  const path = await tripPath(env, t, pts0);
  const tp = tripPlaces(pts0, await getPlaces(env));
  if (pts0.length && !t.circuit && !t.track) {
    const a = pts0[0], b = pts0[pts0.length - 1];
    if (!tp.from) tp.from = await geoName(env, a[0], a[1]);
    if (!tp.to) tp.to = await geoName(env, b[0], b[1]);
  }
  // Con pocas lecturas la punta real se pierde: si sale menor que la media, no es fiable
  if (t.max_speed != null && t.avg_speed && t.max_speed < t.avg_speed) { t.max_speed_low = true; }
  const same = await sameTrips(env, t, pts0).catch(() => null);
  return { ...t, ...tp, points: pts0, path, same, route, ...(await tripSeries(env, t)), cost_eur: t.fuel_used_l != null ? round(t.fuel_used_l * price(t.start_ts), 2) : null, price_l: round(price(t.start_ts), 3) };
}

// Ruta por carretera: el coche solo manda un punto cada ~2 min, así que se calcula el camino real
// entre cada par de puntos (OSRM) y cada tramo conserva su velocidad. Se guarda para no pedirla otra vez.
function sparseTrip(pts) {
  if (pts.length < 2) return false;
  for (let i = 1; i < pts.length; i++) if ((pts[i][3] || 0) - (pts[i - 1][3] || 0) > 180e3 && distKm(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) > 0.5) return true;
  return false;
}
async function tripPath(env, t, pts) {
  if (t.path) { try { const p = JSON.parse(t.path); if (p && p.legs) return p; } catch (e) {} }
  if (t.circuit || t.track || pts.length < 2) return null;
  // Puntos de paso: se saltan los que están a menos de 150 m del anterior (parado en un semáforo, etc.)
  let way = pts.filter((p, i) => i === 0 || i === pts.length - 1 || distKm(p[0], p[1], pts[i - 1][0], pts[i - 1][1]) > 0.15);
  if (way.length < 2) return null;
  if (way.length > 60) { const k = (way.length - 1) / 59; way = Array.from({ length: 60 }, (_, i) => way[Math.round(i * k)]); }
  try {
    const url = 'https://router.project-osrm.org/route/v1/driving/' + way.map(p => p[1].toFixed(5) + ',' + p[0].toFixed(5)).join(';') +
      '?overview=false&steps=true&geometries=geojson&continue_straight=false';
    const r = await fetch(url, { headers: { 'user-agent': 'garaje-coche-app (uso personal)' } });
    if (!r.ok) { await routeErr(env, t.id, 'HTTP ' + r.status); return null; }
    const j = await r.json();
    const route = j.routes && j.routes[0];
    if (!route || !route.legs || route.legs.length !== way.length - 1) { await routeErr(env, t.id, 'sin ruta ' + (j.code || '')); return null; }
    // Si sale mucho más larga o corta que los km del cuentakilómetros, no es la que hiciste
    const km = route.distance / 1000;
    if (t.km && (km > t.km * 1.4 + 1 || km < t.km * 0.6 - 1)) { await routeErr(env, t.id, 'km ' + round(km, 1) + ' vs ' + t.km); return null; }
    const legs = route.legs.map((lg, i) => {
      const c = [];
      for (const st of lg.steps || []) for (const q of (st.geometry && st.geometry.coordinates) || []) {
        const pt = [round(q[1], 5), round(q[0], 5)];
        const l = c[c.length - 1];
        if (!l || l[0] !== pt[0] || l[1] !== pt[1]) c.push(pt);
      }
      if (!c.length) c.push([way[i][0], way[i][1]], [way[i + 1][0], way[i + 1][1]]);
      // velocidad del tramo: la media de sus dos extremos (si el coche la mandó)
      const s0 = way[i][2], s1 = way[i + 1][2];
      return { s: s0 == null && s1 == null ? null : Math.round(((s0 || 0) + (s1 || 0)) / ((s0 != null) + (s1 != null))), c };
    });
    const path = { sparse: sparseTrip(pts), km: round(km, 1), legs };
    await env.DB.prepare('UPDATE trips SET path = ? WHERE id = ?').bind(JSON.stringify(path), t.id).run();
    return path;
  } catch (e) { await routeErr(env, t.id, String(e && e.message || e)); return null; }
}
async function routeErr(env, id, msg) {
  console.error('ruta', id, msg);
  try { await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('route_err', ?)").bind(JSON.stringify({ id, msg, at: Date.now() })).run(); } catch (e) {}
}

const r2 = v => v == null ? null : Math.round(v * 100) / 100;
// Relación km/h por cada 1.000 rpm de cada marcha (Fiesta ST Mk8, aprox.): sirve para deducir la marcha,
// porque en cambio manual Ford no la manda.
let GEAR_KMH_PER_1000 = [7.6, 13.4, 20.3, 27.0, 33.6, 40.6]; // se afinan solas con tus datos (calibrateGears)
function gearFrom(speed, rpm) {
  if (!speed || speed < 8 || !rpm || rpm < 1100) return null;
  const r = speed / (rpm / 1000);
  let best = null, err = 1e9;
  GEAR_KMH_PER_1000.forEach((g, i) => { const e = Math.abs(r - g) / g; if (e < err) { err = e; best = i + 1; } });
  return err < 0.12 ? best : null; // embrague pisado o punto muerto: sin marcha
}

// Afina las relaciones de cambio con las lecturas reales (velocidad/rpm estables en cada marcha)
async function calibrateGears(env) {
  const { results } = await env.DB.prepare("SELECT data FROM snapshots WHERE ts > ? ORDER BY ts").bind(Date.now() - 60 * 86400e3).all();
  const buckets = GEAR_KMH_PER_1000.map(() => []);
  for (const r of results) {
    let c; try { c = JSON.parse(r.data); } catch (e) { continue; }
    if (!(c.speed_kmh >= 10 && c.rpm >= 1300 && !(c.brake_pct > 0))) continue;
    const ratio = c.speed_kmh / (c.rpm / 1000);
    const g = gearFrom(c.speed_kmh, c.rpm);
    if (g) buckets[g - 1].push(ratio);
  }
  const next = GEAR_KMH_PER_1000.map((v, i) => {
    const b = buckets[i].sort((x, y) => x - y);
    return b.length >= 4 ? round(b[Math.floor(b.length / 2)], 2) : v;
  });
  if (next.every((v, i) => i === 0 || v > next[i - 1])) {
    GEAR_KMH_PER_1000 = next;
    await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('gear_ratios', ?)").bind(JSON.stringify(next)).run();
  }
  return { ratios: GEAR_KMH_PER_1000, samples: buckets.map(b => b.length) };
}

// Lecturas del coche durante el trayecto (una por cada dato nuevo que mandó)
async function tripSeries(env, t) {
  const { results } = await env.DB.prepare('SELECT data FROM snapshots WHERE ts BETWEEN ? AND ? ORDER BY ts')
    .bind(t.start_ts - 60e3, t.end_ts + 300e3).all();
  const seen = new Set(), series = [];
  for (const r of results) {
    let c; try { c = JSON.parse(r.data); } catch (e) { continue; }
    const k = c.data_ts || c.ts;
    if (seen.has(k) || k < t.start_ts - 60e3 || k > t.end_ts + 60e3) continue;
    seen.add(k);
    const ty = c.tyres || {};
    series.push({ ts: k, spd: c.speed_kmh || 0, rpm: c.rpm || 0, temp: c.oil_c ?? c.coolant_c ?? null, fuel: c.fuel_pct, bat: c.battery_v,
      thr: c.throttle_pct || 0, brake: c.brake_pct || 0, gear: gearFrom(c.speed_kmh, c.rpm),
      tf: ty.fl != null && ty.fr != null ? r2((ty.fl + ty.fr) / 2) : null, tr: ty.rl != null && ty.rr != null ? r2((ty.rl + ty.rr) / 2) : null });
  }
  const moving = series.filter(p => p.spd > 0);
  const stats = series.length > 3 ? {
    highway_pct: moving.length ? Math.round(moving.filter(p => p.spd >= 90).length / moving.length * 100) : null,
    city_pct: moving.length ? Math.round(moving.filter(p => p.spd < 50).length / moving.length * 100) : null,
    cruise_rpm: (() => { const h = series.filter(p => p.spd >= 110 && p.spd <= 125); return h.length ? Math.round(h.reduce((a, p) => a + p.rpm, 0) / h.length) : null; })(),
    warm_min: (() => { const w = series.find(p => p.temp != null && p.temp >= OIL_WARM); return w ? Math.max(0, Math.round((w.ts - t.start_ts) / 60e3)) : null; })(),
    tyre_rise: (() => { const a = series.find(p => p.tf != null), b = [...series].reverse().find(p => p.tf != null); return a && b ? { front: r2(b.tf - a.tf), rear: r2(b.tr - a.tr), from: [a.tf, a.tr], to: [b.tf, b.tr] } : null; })(),
    alternator_v: (() => { const v = series.filter(p => p.rpm > 1500 && p.bat).map(p => p.bat); return v.length ? r2(v.reduce((a, b) => a + b, 0) / v.length) : null; })(),
    gears: (() => { const g = {}; for (const p of series) if (p.gear) g[p.gear] = (g[p.gear] || 0) + 1; return g; })(),
    cold_revs: (() => { const c = series.filter(p => p.temp != null && p.temp < 70 && p.rpm > 3000); return c.length ? { rpm: Math.max(...c.map(p => p.rpm)), temp: Math.min(...c.map(p => p.temp)) } : null; })()
  } : null;
  return { series, stats };
}

const hhmm = ts => new Date(ts + 3600e3).toISOString().slice(11, 16);

// Precio por litro para un momento dado: último repostaje con precio antes de esa fecha,
// si no el más reciente, si no la media de gasolineras cercanas, si no 1,70 €/L.
async function priceFinder(env) {
  const { results } = await env.DB.prepare('SELECT ts, COALESCE(price_l, price_total / litres) AS pl FROM refuels WHERE price_l > 0 OR (price_total > 0 AND litres > 0) ORDER BY ts').all();
  let fallback = 1.70;
  const fc = await env.DB.prepare("SELECT v FROM kv WHERE k LIKE 'fuel_cache_%' LIMIT 1").first();
  if (fc) {
    const key = 'p' + (env.FUEL_TYPE || '98');
    const ps = JSON.parse(fc.v).list.map(s => s[key]).filter(Boolean);
    if (ps.length) fallback = ps.reduce((a, b) => a + b, 0) / ps.length;
  }
  return ts => {
    let p = null;
    for (const r of results) { if (r.ts <= ts) p = r.pl; else break; }
    return p ?? (results.length ? results[results.length - 1].pl : fallback);
  };
}

// ---------- Vigilancia y aparcamiento ----------

function tripCircuit(t, pts, c) {
  const inside = pts.map(p => circuitAt({ lat: p[0], lon: p[1] }));
  const hits = inside.filter(Boolean);
  const manual = !!(t.track || c.track) && !(c.track && c.track.auto);
  if (!hits.length || hits.length / pts.length < CIRCUIT_MIN_SHARE) return { track: manual, circuit: null };
  const zones = [...new Set(hits.map(h => h.id))];
  const counts = {};
  for (const h of hits) counts[h.name] = (counts[h.name] || 0) + 1;
  const main = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  return { track: true, circuit: sessionName(zones, main) };
}

async function saveCustom(env) {
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('custom_circuits', ?)").bind(JSON.stringify(CUSTOM_CIRCUITS)).run();
  await env.DB.prepare("DELETE FROM kv WHERE k = 'live_cache'").run();
  return { custom: CUSTOM_CIRCUITS };
}

// Guarda la ubicación actual del coche como circuito (para los que no están en la lista).
async function addCustomCircuit(env, b) {
  const car = await readCar(env);
  if (!car.location) return { error: 'No hay ubicación del coche' };
  const name = String(b.name || '').trim().slice(0, 40) || 'Circuito';
  const r = Math.min(3, Math.max(0.5, Number(b.r) || 1.2));
  CUSTOM_CIRCUITS = CUSTOM_CIRCUITS.filter(c => distKm(c.lat, c.lon, car.location.lat, car.location.lon) > 0.5);
  CUSTOM_CIRCUITS.push({ id: 'custom-' + Date.now(), name, lat: round(car.location.lat, 5), lon: round(car.location.lon, 5), r });
  return saveCustom(env);
}

async function delCustomCircuit(env, id) {
  CUSTOM_CIRCUITS = CUSTOM_CIRCUITS.filter(c => c.id !== id);
  return saveCustom(env);
}

// ---------- Historial de precio de tu gasolinera ----------
async function favPriceDaily(env) {
  const type = await userFuelType(env);
  const fav = await favStation(env, type);
  if (!fav || fav.missing) return;
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'fav_prices'").first();
  const hist = row ? JSON.parse(row.v) : [];
  const d = new Date(Date.now() + 3600e3).toISOString().slice(0, 10);
  if (!hist.length || hist[hist.length - 1].d !== d) hist.push({ d, p95: fav.p95 ?? null, p98: fav.p98 ?? null });
  while (hist.length > 180) hist.shift();
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('fav_prices', ?)").bind(JSON.stringify(hist)).run();
  const al = await env.DB.prepare("SELECT v FROM kv WHERE k = 'fav_alert'").first();
  const limit = al ? Number(al.v) : null;
  const p = fav['p' + type];
  const prev = hist.length > 1 ? hist[hist.length - 2]['p' + type] : null;
  if (limit && p && p <= limit && !(prev && prev <= limit)) {
    await sendPushAll(env, { title: '⛽ Gasolina barata', body: `${fav.name} ${titleCase(fav.town)}: la ${type} a ${fmt(p, 3)} €/L (tu aviso: ${fmt(limit, 3)}).`, url: '#datos', tag: 'fav_price' });
  }
}

async function favPrices(env) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'fav_prices'").first();
  const al = await env.DB.prepare("SELECT v FROM kv WHERE k = 'fav_alert'").first();
  return { history: row ? JSON.parse(row.v) : [], alert: al ? Number(al.v) : null };
}

async function setFavAlert(env, b) {
  const v = parseFloat(String(b.limit ?? '').replace(',', '.'));
  if (v > 0.5 && v < 4) await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('fav_alert', ?)").bind(String(v)).run();
  else await env.DB.prepare("DELETE FROM kv WHERE k = 'fav_alert'").run();
  return favPrices(env);
}

// ---------- Pinchazo lento: presiones en frío de cada mañana ----------
async function slowPuncture(env, day) {
  const st = await loadState(env);
  if (st.trip) return;
  const last = await env.DB.prepare('SELECT data FROM snapshots ORDER BY ts DESC LIMIT 1').first();
  if (!last) return;
  const c = JSON.parse(last.data);
  if (!c.tyres || c.track) return;
  // Solo cuenta como "en frío" si lleva al menos 3 h parado
  if (!st.parked || Date.now() - st.parked.ts < 3 * 3600e3) return;
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'cold_tyres'").first();
  const prevHist = row ? JSON.parse(row.v) : [];
  if (prevHist.some(h => h.d === day && h.src === 'arranque')) return;
  const hist = prevHist.filter(h => h.d !== day);
  hist.push({ d: day, ts: Date.now(), ...c.tyres });
  while (hist.length > 30) hist.shift();
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('cold_tyres', ?)").bind(JSON.stringify(hist)).run();
  if (hist.length < 4) return;
  const a = hist[hist.length - 4], b = hist[hist.length - 1];
  const keys = ['fl', 'fr', 'rl', 'rr'].filter(k => a[k] != null && b[k] != null);
  const drop = Object.fromEntries(keys.map(k => [k, a[k] - b[k]]));
  for (const k of keys) {
    const others = keys.filter(x => x !== k).map(x => drop[x]);
    const avgOthers = others.reduce((s, v) => s + v, 0) / (others.length || 1);
    // Pierde 0,1 bar más que las demás en 3 días (las demás bajan igual por el frío)
    if (drop[k] - avgOthers >= 0.1 && drop[k] >= 0.1) {
      await sendPushAll(env, { title: '🛞 Posible pinchazo lento', body: `La rueda ${TYRE_NAMES[k] || k} ha bajado ${fmt(drop[k], 2)} bar en 3 días (en frío), más que las otras. Revísala.`, url: '#estado', tag: 'slow_' + k });
      break;
    }
  }
}

// ---------- Batería y trayectos cortos ----------
async function shortTripsBattery(env, day) {
  const since = Date.now() - 5 * 86400e3;
  const { results } = await env.DB.prepare('SELECT km, duration_s FROM trips WHERE start_ts >= ?').bind(since).all();
  if (results.length < 4 || results.some(t => t.km >= 25 || t.duration_s >= 25 * 60)) return;
  const b = await getBattery(env, 7);
  const days = (b.days || []).filter(d => d.min != null);
  if (days.length < 3) return;
  const lastMin = days[days.length - 1].min, firstMin = days[0].min;
  if (!(lastMin < 12.4 && lastMin < firstMin)) return;
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'short_trips_warn'").first();
  if (row && Date.now() - Number(row.v) < 5 * 86400e3) return;
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('short_trips_warn', ?)").bind(String(Date.now())).run();
  await sendPushAll(env, { title: 'Batería y trayectos cortos', body: `${results.length} trayectos cortos en 5 días y la batería va bajando (${fmt(lastMin, 2)} V en reposo). Un trayecto de 30–40 min por autovía la recargaría.`, url: '#datos', tag: 'short_trips' });
}

// ---------- Gastos del coche ----------
const EXPENSE_CATS = ['Taller', 'Neumáticos', 'Seguro', 'ITV', 'Impuesto', 'Circuito', 'Peajes', 'Lavado', 'Piezas', 'Otros'];

async function rawExpenses(env) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'expenses'").first();
  return row ? JSON.parse(row.v) : [];
}

async function saveExpense(env, b) {
  let list = await rawExpenses(env);
  if (b.delete) list = list.filter(e => e.id !== b.delete);
  else {
    const eur = Number(String(b.eur ?? '').replace(',', '.'));
    if (!(eur > 0 && eur < 100000)) throw httpError('El importe no es válido', 400);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : new Date().toISOString().slice(0, 10);
    const cat = EXPENSE_CATS.includes(b.cat) ? b.cat : 'Otros';
    const item = { id: b.id || 'e' + Date.now(), date, cat, desc: String(b.desc || '').trim().slice(0, 80), eur: round(eur, 2) };
    const i = list.findIndex(e => e.id === item.id);
    if (i >= 0) list[i] = item; else list.push(item);
  }
  list.sort((a, c) => c.date.localeCompare(a.date));
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('expenses', ?)").bind(JSON.stringify(list)).run();
  return listExpenses(env, b.year);
}

async function listExpenses(env, year) {
  const y = Number(year) || new Date().getFullYear();
  const from = Date.UTC(y, 0, 1) - 3600e3, to = Date.UTC(y + 1, 0, 1) - 3600e3;
  const items = (await rawExpenses(env)).filter(e => e.date.startsWith(String(y)));
  const { results: rf } = await env.DB.prepare('SELECT ts, price_total, litres, station FROM refuels WHERE ts >= ? AND ts < ? AND price_total > 0 ORDER BY ts DESC').bind(from, to).all();
  const fuel = round(rf.reduce((a, r) => a + r.price_total, 0), 2);
  const byCat = {};
  for (const e of items) byCat[e.cat] = round((byCat[e.cat] || 0) + e.eur, 2);
  if (fuel) byCat['Gasolina'] = fuel;
  const total = round(Object.values(byCat).reduce((a, v) => a + v, 0), 2);
  const o1 = await env.DB.prepare('SELECT MIN(odometer) AS a, MAX(odometer) AS b FROM snapshots WHERE ts >= ? AND ts < ? AND odometer IS NOT NULL').bind(from, to).first();
  const km = o1 && o1.a != null ? Math.round(o1.b - o1.a) : 0;
  return { year: y, cats: EXPENSE_CATS, items, refuels: rf, by_cat: byCat, total, km, eur_km: km > 50 ? round(total / km, 3) : null };
}

// ---------- Salud de la conexión con Ford ----------
async function fordHealth(env, err) {
  if (src(env) !== 'ford') return;
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'ford_health'").first();
  const h = row ? JSON.parse(row.v) : { failSince: null, alerted: false };
  if (!err) {
    if (h.alerted) await sendPushAll(env, { title: 'Ford conectado de nuevo', body: 'Vuelven a llegar los datos del coche.', url: '#estado', tag: 'ford_down' });
    if (h.failSince) await env.DB.prepare("DELETE FROM kv WHERE k = 'ford_health'").run();
    return;
  }
  h.failSince = h.failSince || Date.now();
  h.last = String(err && err.message || err).slice(0, 200);
  if (!h.alerted && Date.now() - h.failSince > 3600e3) {
    h.alerted = true;
    await sendPushAll(env, { title: '⚠️ Sin conexión con Ford', urgent: true, url: '#ajustes', tag: 'ford_down',
      body: 'Llevo más de una hora sin poder leer el coche (puede que haya caducado el acceso o cambiaste la contraseña de FordPass). Ajustes → Conexión con Ford para ver cómo reconectar.' });
  }
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('ford_health', ?)").bind(JSON.stringify(h)).run();
}

// ---------- Copia de seguridad semanal (en un almacén aparte de la base de datos) ----------
async function weeklyBackup(env, when) {
  if (!env.BACKUPS) return;
  const local = new Date(when + 3600e3);
  if (local.getUTCDay() !== 0 || local.getUTCHours() !== 4 || local.getUTCMinutes() !== 0) return; // domingos a las 4:00
  const data = JSON.stringify(await exportAll(env));
  const key = 'copia-' + local.toISOString().slice(0, 10);
  await env.BACKUPS.put(key, data, { metadata: { bytes: data.length, at: Date.now() } });
  const { keys } = await env.BACKUPS.list({ prefix: 'copia-' });
  const old = keys.map(k => k.name).sort().slice(0, -12); // se quedan las 12 últimas (3 meses)
  for (const k of old) await env.BACKUPS.delete(k);
}

async function listBackups(env) {
  if (!env.BACKUPS) return { backups: [] };
  const { keys } = await env.BACKUPS.list({ prefix: 'copia-' });
  return { backups: keys.map(k => ({ name: k.name, bytes: k.metadata && k.metadata.bytes, at: k.metadata && k.metadata.at })).sort((a, b) => b.name.localeCompare(a.name)) };
}

async function getBackup(env, name) {
  if (!env.BACKUPS || !/^copia-\d{4}-\d{2}-\d{2}$/.test(name)) throw httpError('Copia no encontrada', 404);
  const v = await env.BACKUPS.get(name);
  if (!v) throw httpError('Copia no encontrada', 404);
  return JSON.parse(v);
}

// ---------- Limpieza: lecturas de hace más de un año, una por día ----------
async function pruneOld(env) {
  const cutoff = Date.now() - 365 * 86400e3;
  await env.DB.prepare(`DELETE FROM snapshots WHERE ts < ? AND ts NOT IN (
    SELECT MIN(ts) FROM snapshots WHERE ts < ? GROUP BY date((ts + 3600000) / 1000, 'unixepoch'))`).bind(cutoff, cutoff).run();
}

// ---------- Lugares guardados (Casa, Trabajo…) ----------
async function getPlaces(env) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'places'").first();
  return row ? JSON.parse(row.v) : [];
}

async function savePlace(env, b) {
  let list = await getPlaces(env);
  const name = String(b.name || '').trim().slice(0, 30);
  if (b.delete) list = list.filter(p => p.name !== b.delete);
  else {
    if (!name) throw httpError('Ponle un nombre', 400);
    let lat = Number(b.lat), lon = Number(b.lon);
    if (isNaN(lat) || isNaN(lon)) { const c = await readCar(env); if (!c.location) throw httpError('No hay ubicación del coche', 400); lat = c.location.lat; lon = c.location.lon; }
    list = list.filter(p => p.name.toLowerCase() !== name.toLowerCase());
    list.push({ name, lat: round(lat, 5), lon: round(lon, 5), r: 0.4 });
  }
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('places', ?)").bind(JSON.stringify(list)).run();
  return { places: list };
}

function placeAt(lat, lon, places) {
  if (lat == null) return null;
  let best = null, bd = 1e9;
  for (const p of places) { const d = distKm(lat, lon, p.lat, p.lon); if (d <= (p.r || 0.4) && d < bd) { bd = d; best = p.name; } }
  return best;
}

// ---------- Nombre de un sitio sin guardar (OpenStreetMap) ----------
// Primero un comercio/lugar con nombre a menos de 70 m (p. ej. "Mercadona Centro"); si no, la calle y el pueblo.
const geoKey = (lat, lon) => lat.toFixed(4) + ',' + lon.toFixed(4); // ~10 m
const UA = { 'user-agent': 'garaje-coche-app/1.0 (app personal)', 'accept-language': 'es' };
const POI_SKIP = /^(parking|parking_entrance|parking_space|bench|waste_basket|waste_disposal|recycling|vending_machine|post_box|bicycle_parking|toilets|telephone|atm|shelter|drinking_water|charging_station|motorcycle_parking|fountain|clock|bicycle_rental|letter_box|grit_bin|hunting_stand|loading_dock)$/;

async function geoName(env, lat, lon) {
  if (lat == null || lon == null) return null;
  const k = geoKey(lat, lon);
  const c = await env.DB.prepare('SELECT name FROM geo WHERE k = ?').bind(k).first();
  if (c) return c.name;
  let town = null, road = null, poi = null, failed = false;
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=${lat}&lon=${lon}`, { headers: UA });
    if (r.ok) {
      const j = await r.json(), a = j.address || {};
      town = a.village || a.town || a.city || a.municipality || a.hamlet || null;
      road = a.road || a.pedestrian || a.square || null;
      if (j.name && j.category !== 'highway' && j.category !== 'building' && j.category !== 'place' && j.name !== road) poi = j.name;
    } else failed = true;
  } catch (e) { failed = true; }
  // Comercio o sitio con nombre más cercano (capa de puntos de interés de Nominatim)
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&layer=poi&zoom=18&addressdetails=1&lat=${lat}&lon=${lon}`, { headers: UA });
    if (r.ok) {
      const j = await r.json();
      const d = j.lat ? distKm(lat, lon, Number(j.lat), Number(j.lon)) : 9;
      if (j.name && d <= 0.09 && !POI_SKIP.test(j.type || '')) poi = j.name;
      else if (!j.name && j.error == null) geoDebug(env, 'poi sin nombre ' + (j.type || '') + ' ' + round(d * 1000) + 'm');
      else if (j.name) geoDebug(env, 'poi lejos ' + j.name + ' ' + round(d * 1000) + 'm');
    } else geoDebug(env, 'poi HTTP ' + r.status);
  } catch (e) { geoDebug(env, 'poi ' + e.message); }
  let name = poi ? (town && !poi.toLowerCase().includes(town.toLowerCase()) ? `${poi} ${town}` : poi)
    : road ? (town ? `${road}, ${town}` : road) : town;
  if (!name && failed) return null; // reintentar más tarde
  name = name ? String(name).slice(0, 60) : null;
  await env.DB.prepare('INSERT OR REPLACE INTO geo VALUES (?, ?, ?)').bind(k, name, Date.now()).run();
  if (GEO_DBG.length) { await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('geo_dbg', ?)").bind(JSON.stringify({ k, m: GEO_DBG.slice(-6) })).run(); GEO_DBG = []; }
  return name;
}
let GEO_DBG = [];
function geoDebug(env, m) { GEO_DBG.push(m); }
async function geoCached(env, pairs) {
  const keys = [...new Set(pairs.filter(p => p && p[0] != null).map(p => geoKey(p[0], p[1])))];
  const out = {};
  for (let i = 0; i < keys.length; i += 50) {
    const ks = keys.slice(i, i + 50);
    const { results } = await env.DB.prepare(`SELECT k, name FROM geo WHERE k IN (${ks.map(() => '?').join(',')})`).bind(...ks).all();
    for (const r of results) out[r.k] = r.name;
  }
  return out;
}
// En el cron: pone nombre a una salida/llegada pendiente por minuto (para no saturar OpenStreetMap)
async function geoBackfill(env) {
  const places = await getPlaces(env);
  const { results } = await env.DB.prepare('SELECT id, start_lat, start_lon, end_lat, end_lon FROM trips WHERE COALESCE(track, 0) = 0 ORDER BY start_ts DESC LIMIT 60').all();
  const cache = await geoCached(env, results.flatMap(t => [[t.start_lat, t.start_lon], [t.end_lat, t.end_lon]]));
  for (const t of results) for (const [la, lo] of [[t.start_lat, t.start_lon], [t.end_lat, t.end_lon]]) {
    if (la == null || placeAt(la, lo, places) || geoKey(la, lo) in cache) continue;
    await geoName(env, la, lo);
    return;
  }
}

// En el cron: calcula la ruta por carretera de un trayecto antiguo cada minuto
async function pathBackfill(env) {
  const t = await env.DB.prepare("SELECT * FROM trips WHERE path IS NULL AND COALESCE(track, 0) = 0 AND circuit IS NULL AND id NOT IN (SELECT CAST(v AS INTEGER) FROM kv WHERE k LIKE 'nopath_%') ORDER BY start_ts DESC LIMIT 1").first();
  if (!t) return;
  const p = await tripPath(env, t, JSON.parse(t.points || '[]'));
  if (!p) await env.DB.prepare('INSERT OR REPLACE INTO kv VALUES (?, ?)').bind('nopath_' + t.id, String(t.id)).run();
}

function tripPlaces(pts, places) {
  if (!pts.length || !places.length) return { from: null, to: null };
  const a = pts[0], b = pts[pts.length - 1];
  return { from: placeAt(a[0], a[1], places), to: placeAt(b[0], b[1], places) };
}

// Ida y vuelta entre dos lugares guardados (p. ej. Casa ↔ Trabajo): media de tiempo, km y coste
function commuteStats(rows, places, price) {
  if (places.length < 2) return null;
  const groups = {};
  for (const t of rows) {
    const { from, to } = tripPlaces(JSON.parse(t.points || '[]'), places);
    if (!from || !to || from === to) continue;
    const k = [from, to].sort().join(' ↔ ');
    (groups[k] = groups[k] || []).push(t);
  }
  return Object.entries(groups).map(([route, ts]) => ({
    route, count: ts.length,
    avg_min: Math.round(ts.reduce((a, t) => a + t.duration_s, 0) / ts.length / 60),
    best_min: Math.round(Math.min(...ts.map(t => t.duration_s)) / 60),
    avg_km: round(ts.reduce((a, t) => a + t.km, 0) / ts.length, 1),
    avg_cost: (() => { const c = ts.filter(t => t.fuel_used_l != null && t.km >= 3); return c.length ? round(c.reduce((a, t) => a + t.fuel_used_l * price(t.start_ts), 0) / c.length, 2) : null; })()
  })).sort((a, b) => b.count - a.count);
}

// ---------- Frenos: el circuito desgasta más ----------
const PAD_TRACK_FACTOR = 5;      // 1 km de circuito ≈ 5 km de carretera para las pastillas
const FLUID_DAYS_PER_TRACKDAY = 60; // cada día de circuito adelanta 2 meses el cambio de líquido

async function trackSince(env, dateStr) {
  const since = dateStr ? Date.parse(dateStr + 'T00:00:00Z') : 0;
  const r = await env.DB.prepare(`SELECT COALESCE(SUM(km), 0) AS km, COUNT(DISTINCT date((start_ts + 3600000) / 1000, 'unixepoch')) AS days
    FROM trips WHERE track = 1 AND start_ts >= ?`).bind(since).first();
  return { km: r ? r.km : 0, days: r ? r.days : 0 };
}

async function brakeWear(env, i, odo) {
  if (!i.last_date && i.last_km == null) return i;
  if (/pastilla|disco/i.test(i.name) && i.interval_km && i.last_km != null) {
    const t = await trackSince(env, i.last_date);
    if (t.km > 0) {
      const extra = Math.round(t.km * (PAD_TRACK_FACTOR - 1));
      return { ...i, last_km: i.last_km - extra, track_note: `${fmt(t.km, 0)} km en circuito cuentan como ${fmt(t.km * PAD_TRACK_FACTOR, 0)}` };
    }
  }
  if (/l[ií]quido de frenos/i.test(i.name) && i.interval_months && i.last_date) {
    const t = await trackSince(env, i.last_date);
    if (t.days > 0) {
      const d = new Date(i.last_date + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - t.days * FLUID_DAYS_PER_TRACKDAY);
      return { ...i, last_date: d.toISOString().slice(0, 10), real_last_date: i.last_date, track_note: `${t.days} día${t.days > 1 ? 's' : ''} de circuito: adelanta el cambio` };
    }
  }
  return i;
}

// ---------- Neumáticos montados ----------
async function getTyreSet(env) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'tyre_set'").first();
  const t = row ? JSON.parse(row.v) : { model: null, size: null, mounted_date: null, mounted_km: null, rotated_km: null };
  const odo = await currentOdo(env);
  const out = { ...t, odometer: odo, km: null, track_km: 0, track_days: 0, rotate_in_km: null };
  const ctr = await env.DB.prepare("SELECT v FROM kv WHERE k = 'cold_tyres'").first();
  if (ctr) { const h = JSON.parse(ctr.v); out.cold = h[h.length - 1] || null; }
  if (t.mounted_km != null && odo != null) out.km = Math.max(0, Math.round(odo - t.mounted_km));
  if (t.mounted_date) Object.assign(out, (({ km, days }) => ({ track_km: round(km, 1), track_days: days }))(await trackSince(env, t.mounted_date)));
  out.track_km = round((out.track_km || 0) + (t.track_extra_km || 0), 0);
  out.track_days = (out.track_days || 0) + (t.track_extra_days || 0);
  const base = t.rotated_km ?? t.mounted_km;
  if (base != null && odo != null) out.rotate_in_km = Math.round(base + 10000 - odo);
  // Vida orientativa: semi-slick (SuperSport R/RS, Cup, Trofeo) ~20.000 km; deportivo de calle como la SuperSport ~35.000 km;
  // cada km de circuito gasta como ~8 de carretera. Se puede fijar a mano con life_km.
  out.life_km = t.life_km || (/supersport\s*rs?\b|cup|trofeo|semi/i.test(t.model || '') ? 20000 : /supersport|pilot sport 4|ps4|p zero/i.test(t.model || '') ? 35000 : 40000);
  // Con medidas del dibujo se calcula el desgaste real (la rueda más gastada manda). Nuevas: ~7 mm; mínimo legal 1,6 mm.
  const tr = (t.tread || []).filter(x => x.km != null);
  if (tr.length && t.mounted_km != null) {
    const zmin = z => z == null ? null : typeof z === 'number' ? z : Math.min(...[z.o, z.c, z.i].filter(v => v != null));
    const minOf = x => Math.min(...['fl', 'fr', 'rl', 'rr'].map(k => zmin(x[k])).filter(v => v != null));
    const last = tr[tr.length - 1], lastMin = minOf(last);
    // Dibujo de nuevas: el que pongas; si no, Eagle F1 SuperSport 225/40 R18 = 9/32" ≈ 7,1 mm (ficha de la medida); otros, 7,5 mm
    const newMm = t.new_mm || (/supersport/i.test(t.model || '') ? 7.1 : 7.5);
    let rate = null; // mm por cada 1.000 km
    if (tr.length >= 2 && last.km - tr[0].km >= 2000) rate = (minOf(tr[0]) - lastMin) / ((last.km - tr[0].km) / 1000);
    if (!(rate > 0) && last.km - t.mounted_km >= 2000) rate = (newMm - lastMin) / ((last.km - t.mounted_km) / 1000);
    out.tread_last = { ...last, min: lastMin };
    out.tread_prev = tr.length >= 2 ? tr[tr.length - 2] : null;
    out.new_mm = newMm;
    // Cómo se gastan: centro (presión alta), hombros (presión baja) o un lado (alineación/caída)
    const NAMES = { fl: 'delantera izq.', fr: 'delantera der.', rl: 'trasera izq.', rr: 'trasera der.' };
    out.tread_notes = [];
    for (const k of ['fl', 'fr', 'rl', 'rr']) {
      const z = last[k];
      if (!z || typeof z !== 'object' || z.o == null || z.c == null || z.i == null) continue;
      if (z.c < Math.min(z.o, z.i) - 0.5) out.tread_notes.push(`${NAMES[k]}: más gastada en el centro (suele ser presión alta)`);
      else if (z.o < z.c - 0.5 && z.i < z.c - 0.5) out.tread_notes.push((out.track_km || t.track_extra_km) > 0
        ? `${NAMES[k]}: hombros más gastados que el centro (normal si vas a circuito: en curva apoya el hombro; si no, sería presión baja)`
        : `${NAMES[k]}: gastados los dos hombros (suele ser presión baja)`);
      else if (Math.abs(z.o - z.i) >= 0.8) out.tread_notes.push(`${NAMES[k]}: más gastada por ${z.i < z.o ? 'dentro' : 'fuera'} (revisa alineación/caída)`);
    }
    out.tread_rate = rate > 0 ? round(rate, 2) : null;
    if (rate > 0) {
      const sinceKm = odo != null ? odo - last.km : 0;
      const nowMm = Math.max(0, lastMin - rate * sinceKm / 1000);
      out.tread_now = round(nowMm, 1);
      out.left_km = Math.max(0, Math.round((nowMm - 1.6) / rate * 1000));
      out.left_3mm_km = Math.max(0, Math.round((nowMm - 3) / rate * 1000));
      out.life_km = Math.round((newMm - 1.6) / rate * 1000);
      out.from_tread = true;
    }
  }
  if (out.km != null && !out.from_tread) {
    const used = out.km + (out.track_km || 0) * 7;
    out.left_km = Math.max(0, Math.round(out.life_km - used));
  }
  if (out.left_km != null) {
    const kpd = await kmPerDay(env);
    out.eta = kpd > 1 ? etaDate(out.left_km / kpd) : null;
  }
  return out;
}

async function setTyreSet(env, b) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'tyre_set'").first();
  const t = row ? JSON.parse(row.v) : {};
  const n = v => (v === '' || v == null || isNaN(Number(String(v).replace(/\./g, '').replace(',', '.'))) ? null : Math.round(Number(String(v).replace(/\./g, '').replace(',', '.'))));
  if (b.rotated) t.rotated_km = await currentOdo(env);
  else if (b.tread) {
    // Medida del dibujo en mm de cada rueda (con medidor o con una moneda de 1 €)
    const mm = v => { const x = Number(String(v ?? '').replace(',', '.')); return x > 0.5 && x < 12 ? round(x, 1) : null; };
    // Cada rueda: exterior, centro e interior (o un solo número)
    const zones = v => {
      if (v && typeof v === 'object') { const z = { o: mm(v.o), c: mm(v.c), i: mm(v.i) }; return [z.o, z.c, z.i].some(x => x != null) ? z : null; }
      const x = mm(v); return x != null ? { o: null, c: x, i: null } : null;
    };
    const m = { date: new Date(Date.now() + 3600e3).toISOString().slice(0, 10), km: await currentOdo(env) };
    for (const k of ['fl', 'fr', 'rl', 'rr']) m[k] = zones(b.tread[k]);
    if (!['fl', 'fr', 'rl', 'rr'].some(k => m[k])) throw httpError('Pon al menos una medida en mm', 400);
    t.tread = [...(t.tread || []).filter(x => x.date !== m.date), m].slice(-20);
    if (b.new_mm != null && b.new_mm !== '') t.new_mm = mm(b.new_mm);
  } else {
    t.model = String(b.model || '').trim().slice(0, 60) || null;
    t.size = String(b.size || '').trim().slice(0, 30) || null;
    t.mounted_date = /^\d{4}-\d{2}-\d{2}$/.test(b.mounted_date || '') ? b.mounted_date : null;
    t.mounted_km = n(b.mounted_km);
    // Tandas de circuito de antes de tener la app (o que la app no vio): vueltas × longitud
    if (b.track_extra_km != null) { const x = Number(String(b.track_extra_km).replace(',', '.')); t.track_extra_km = x >= 0 && x < 20000 ? round(x, 0) : t.track_extra_km || 0; }
    if (b.track_extra_days != null) { const x = Number(b.track_extra_days); t.track_extra_days = x >= 0 && x < 200 ? Math.round(x) : t.track_extra_days || 0; }
  }
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('tyre_set', ?)").bind(JSON.stringify(t)).run();
  return getTyreSet(env);
}

// ---------- Días de circuito ----------
async function trackDays(env) {
  const { results } = await env.DB.prepare(
    `SELECT date((start_ts + 3600000) / 1000, 'unixepoch') AS day, COALESCE(circuit, 'Circuito') AS circuit,
      COUNT(*) AS sessions, SUM(km) AS km, SUM(duration_s) AS secs, MAX(max_speed) AS top_speed, MAX(max_rpm) AS top_rpm,
      MAX(max_oil) AS top_temp, SUM(fuel_used_l) AS fuel_l, MIN(start_ts) AS first_ts
     FROM trips WHERE track = 1 GROUP BY day, COALESCE(circuit, 'Circuito') ORDER BY day DESC LIMIT 60`).all();
  const price = await priceFinder(env);
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'track_notes'").first();
  const notes = row ? JSON.parse(row.v) : {};
  return { days: results.map(d => ({ ...d, km: round(d.km || 0, 1), fuel_l: d.fuel_l != null ? round(d.fuel_l, 1) : null,
    cost_eur: d.fuel_l != null ? round(d.fuel_l * price(d.first_ts), 2) : null, note: notes[d.day + '|' + d.circuit] || '' })) };
}

async function setTrackNote(env, b) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'track_notes'").first();
  const notes = row ? JSON.parse(row.v) : {};
  const key = String(b.day || '') + '|' + String(b.circuit || '');
  const note = String(b.note || '').trim().slice(0, 2000);
  if (note) notes[key] = note; else delete notes[key];
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('track_notes', ?)").bind(JSON.stringify(notes)).run();
  return { ok: true };
}

// ---------- Fechas: ITV, seguro, impuesto ----------
async function rawDeadlines(env) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'deadlines'").first();
  return row ? JSON.parse(row.v) : [
    { id: 'itv', name: 'ITV', date: null }, { id: 'seguro', name: 'Seguro', date: null }, { id: 'ivtm', name: 'Impuesto de circulación', date: null }
  ];
}

async function listDeadlines(env) {
  const now = Date.now();
  const items = (await rawDeadlines(env)).map(d => {
    const days = d.date ? Math.ceil((Date.parse(d.date + 'T00:00:00Z') - now) / 86400e3) : null;
    return { ...d, days, status: days == null ? 'sin datos' : days < 0 ? 'vencido' : days <= 30 ? 'pronto' : 'ok' };
  }).sort((a, b) => (a.days ?? 1e9) - (b.days ?? 1e9));
  return { items };
}

async function saveDeadline(env, b) {
  const list = await rawDeadlines(env);
  const name = String(b.name || '').trim().slice(0, 50);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : null;
  const i = list.findIndex(d => d.id === b.id);
  if (i >= 0) list[i] = { ...list[i], name: name || list[i].name, date };
  else { if (!name) throw httpError('Ponle un nombre', 400); list.push({ id: 'd' + Date.now(), name, date }); }
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('deadlines', ?)").bind(JSON.stringify(list)).run();
  return listDeadlines(env);
}

async function deleteDeadline(env, id) {
  const list = (await rawDeadlines(env)).filter(d => d.id !== id);
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('deadlines', ?)").bind(JSON.stringify(list)).run();
  return listDeadlines(env);
}

// ---------- Widget (Scriptable / Atajos) ----------
async function widget(env) {
  const c = await getLive(env); // lo que lee el widget también cuenta para detectar el arranque
  return {
    range_km: c.range_km, fuel_pct: c.fuel_pct, locked: c.locked, doors_open: c.doors_open || [],
    tyres: c.tyres, tyres_low: c.tyres_low || [], battery_v: c.battery_v, battery_soc: c.battery_soc ?? null, odometer_km: c.odometer_km,
    alerts: c.alerts || [], data_ts: c.data_ts || c.ts, circuit: c.circuit || null,
    lock_checking: !!c.lock_checking, windows_open: c.windows_open || [],
    engine_c: c.oil_c ?? c.coolant_c ?? null, oil_life_pct: c.oil_life_pct ?? null, battery_soc: c.battery_soc ?? null,
    ignition: c.ignition, speed_kmh: c.speed_kmh || 0, next: await widgetNext(env)
  };
}

// Lo próximo que toca: fecha o mantenimiento más cercano
async function widgetNext(env) {
  try {
    const { items: dl } = await listDeadlines(env);
    const { items: mt } = await listMaint(env);
    const c = [];
    for (const d of dl) if (d.days != null && d.days <= 60) c.push({ text: d.days < 0 ? `${d.name} vencido` : `${d.name} en ${d.days} d`, urgent: d.days <= 7, w: d.days });
    for (const m of mt) if (m.status === 'vencido' || m.status === 'pronto') c.push({ text: `${m.name}: ${m.summary.split(' · ')[0]}`, urgent: m.status === 'vencido', w: m.status === 'vencido' ? -1 : 30 });
    c.sort((a, b) => a.w - b.w);
    return c[0] || null;
  } catch (e) { return null; }
}

async function circuitStats(env) {
  const { results } = await env.DB.prepare(
    `SELECT circuit, COUNT(*) AS sessions, COUNT(DISTINCT date((start_ts + 3600000) / 1000, 'unixepoch')) AS days,
      MAX(max_speed) AS top_speed, MAX(max_rpm) AS top_rpm, MAX(max_oil) AS top_temp, SUM(km) AS km,
      SUM(duration_s) AS secs, MAX(start_ts) AS last_ts
     FROM trips WHERE circuit IS NOT NULL GROUP BY circuit ORDER BY last_ts DESC`
  ).all();
  return { circuits: results, known: CIRCUITS.map(c => c.name), custom: CUSTOM_CIRCUITS };
}

async function getTrack(env) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'track'").first();
  const t = row ? JSON.parse(row.v) : {};
  return { until: t.until || null, active: !!(t.until && t.until > Date.now()) };
}

async function setTrack(env, b) {
  let until = null;
  if (b.until === 'midnight') {
    const d = new Date(Date.now() + 3600e3);
    d.setUTCHours(23, 59, 0, 0);
    until = d.getTime() - 3600e3;
  } else if (Number(b.hours) > 0 && Number(b.hours) <= 24) until = Date.now() + Number(b.hours) * 3600e3;
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('track', ?)").bind(JSON.stringify({ until })).run();
  await env.DB.prepare("DELETE FROM kv WHERE k = 'live_cache'").run();
  return getTrack(env);
}

// Presiones de referencia propias (bar). Si no hay, se usan las que manda el coche.
async function getTyrePrefs(env) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'tyre_prefs'").first();
  return { front: null, rear: null, ...(row ? JSON.parse(row.v) : {}) };
}

async function setTyrePrefs(env, b) {
  const v = x => { const n = parseFloat(String(x ?? '').replace(',', '.')); return n >= 1.5 && n <= 3.5 ? Math.round(n * 100) / 100 : null; };
  const t = { front: v(b.front), rear: v(b.rear) };
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('tyre_prefs', ?)").bind(JSON.stringify(t)).run();
  await env.DB.prepare("DELETE FROM kv WHERE k = 'live_cache'").run();
  return t;
}

function applyTyrePrefs(car, pr) {
  if (!car || !car.tyres || (!pr.front && !pr.rear)) return car;
  const car_ref = car.tyre_ref || {};
  const ref = { ...car_ref };
  if (pr.front) ref.fl = ref.fr = pr.front;
  if (pr.rear) ref.rl = ref.rr = pr.rear;
  car.tyre_ref = ref;
  car.tyre_ref_custom = true;
  // Baja: más de un 12 % por debajo de tu presión, o el coche la marca como baja
  const carLow = car.tyres_low_car || car.tyres_low || [];
  car.tyres_low_car = carLow;
  car.tyres_low = Object.keys(car.tyres).filter(k => car.tyres[k] != null && ((ref[k] && car.tyres[k] < ref[k] * 0.88) || carLow.includes(k)));
  return car;
}

async function getGuard(env) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'guard'").first();
  return { enabled: false, night: true, from: '00:00', to: '06:00', ...(row ? JSON.parse(row.v) : {}) };
}

async function setGuard(env, b) {
  const t = v => (/^\d{2}:\d{2}$/.test(v || '') ? v : null);
  const g = { ...(await getGuard(env)) };
  if (typeof b.enabled === 'boolean') g.enabled = b.enabled;
  if (typeof b.night === 'boolean') g.night = b.night;
  if (t(b.from)) g.from = b.from;
  if (t(b.to)) g.to = b.to;
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('guard', ?)").bind(JSON.stringify(g)).run();
  return g;
}

function guardActive(g, ts) {
  if (g.enabled) return true;
  if (!g.night) return false;
  const now = hhmm(ts);
  return g.from <= g.to ? now >= g.from && now < g.to : now >= g.from || now < g.to;
}

async function getParking(env) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'parking'").first();
  return row ? JSON.parse(row.v) : null;
}

async function setParking(env, b) {
  const p = await getParking(env);
  if (!p) throw httpError('Todavía no hay ningún aparcamiento guardado', 404);
  if ('note' in b) p.note = b.note ? String(b.note).slice(0, 120) : null;
  if ('minutes' in b) {
    const min = Number(b.minutes);
    p.timer_at = min > 0 && min <= 24 * 60 ? Date.now() + min * 60e3 : null;
    p.timer_warned = false;
  }
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('parking', ?)").bind(JSON.stringify(p)).run();
  return p;
}

async function parkingTimer(env) {
  const p = await getParking(env);
  if (!p || !p.timer_at) return;
  const left = p.timer_at - Date.now();
  if (left <= 10 * 60e3 && !p.timer_warned) {
    p.timer_warned = true;
    await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('parking', ?)").bind(JSON.stringify(p)).run();
    await sendPushAll(env, { title: 'Aparcamiento', body: left > 60e3 ? `Te quedan ${Math.round(left / 60e3)} minutos de aparcamiento.` : 'Se ha acabado el tiempo de aparcamiento.', url: '#estado', tag: 'parking', urgent: true });
  }
}

async function exportAll(env) {
  const all = async sql => (await env.DB.prepare(sql).all()).results;
  const [snapshots, refuels, trips, maintenance, kv] = await Promise.all([
    all('SELECT ts, odometer, fuel_pct, battery_v, data FROM snapshots ORDER BY ts'),
    all('SELECT * FROM refuels ORDER BY ts'),
    all('SELECT * FROM trips ORDER BY start_ts'),
    all('SELECT * FROM maintenance ORDER BY id'),
    all("SELECT k, v FROM kv WHERE k NOT IN ('ford', 'vapid', 'ford_raw', 'ford_raw_at', 'live_cache', 'state', 'daily') AND k NOT LIKE 'fuel_cache_%' AND k NOT LIKE 'nopath_%' AND k NOT IN ('geo_dbg', 'route_err')")
  ]);
  return { app: 'garaje-coche-app', schema: SCHEMA, exported_at: new Date().toISOString(), source: src(env) || 'mock', snapshots, refuels, trips, maintenance, settings: kv };
}

async function tripRecords(env) {
  const cols = 'id, start_ts, km, duration_s, avg_speed, max_speed, max_rpm, fuel_used_l';
  const q = sql => env.DB.prepare(sql).first();
  const [top, eff, longest, rpm] = await Promise.all([
    q(`SELECT ${cols} FROM trips WHERE COALESCE(track, 0) = 0 ORDER BY max_speed DESC LIMIT 1`),
    q(`SELECT ${cols}, fuel_used_l / km * 100 AS l100 FROM trips WHERE COALESCE(track, 0) = 0 AND km >= 5 AND fuel_used_l > 0 ORDER BY l100 ASC LIMIT 1`),
    q(`SELECT ${cols} FROM trips WHERE COALESCE(track, 0) = 0 ORDER BY km DESC LIMIT 1`),
    q(`SELECT ${cols} FROM trips WHERE COALESCE(track, 0) = 0 ORDER BY max_rpm DESC LIMIT 1`)
  ]);
  if (eff) eff.l100 = round(eff.l100, 1);
  return { top_speed: top, best_eff: eff, longest, top_rpm: rpm };
}

async function weeklySummary(env) {
  const from = Date.now() - 7 * 86400e3;
  const t = await env.DB.prepare('SELECT COUNT(*) AS n, SUM(km) AS km, SUM(fuel_used_l) AS fuel, MAX(max_speed) AS top FROM trips WHERE start_ts >= ?').bind(from).first();
  const r = await env.DB.prepare('SELECT SUM(price_total) AS eur, COUNT(*) AS n FROM refuels WHERE ts >= ?').bind(from).first();
  const { items } = await listMaint(env);
  const due = items.filter(i => i.status === 'vencido' || i.status === 'pronto').length;
  const parts = [`${fmt(t.km || 0)} km en ${t.n || 0} trayectos`];
  if (t.km > 20 && t.fuel) parts.push(`${fmt(t.fuel / t.km * 100, 1)} l/100 km`);
  if (r.eur) parts.push(`${fmt(r.eur, 2)} € en gasolina`);
  if (t.top) parts.push(`punta ${t.top} km/h`);
  try {
    const { commute } = await listTrips(env, 200);
    const c = commute && commute[0];
    if (c) {
      const { results } = await env.DB.prepare('SELECT points, duration_s FROM trips WHERE start_ts >= ?').bind(from).all();
      const places = await getPlaces(env);
      const wk = results.filter(t => { const { from: a, to: b } = tripPlaces(JSON.parse(t.points || '[]'), places); return a && b && a !== b && [a, b].sort().join(' ↔ ') === c.route; });
      if (wk.length) parts.push(`${c.route}: ${wk.length} viajes, media ${Math.round(wk.reduce((s, t) => s + t.duration_s, 0) / wk.length / 60)} min`);
    }
  } catch (e) { /* sin lugares */ }
  parts.push(due ? `${due} tarea${due > 1 ? 's' : ''} de taller pendiente${due > 1 ? 's' : ''}` : 'todo al día en el taller');
  return { title: 'Tu semana con el ST', body: parts.join(' · '), url: '#viajes', tag: 'weekly' };
}

// ---------- Gasolineras (datos oficiales del Ministerio) ----------

function distKm(a, b, c, d) {
  const R = 6371, r = x => x * Math.PI / 180;
  const h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Centro aproximado de cada provincia (código INE) para saber dónde buscar gasolineras.
const PROVINCES = {
  '01': [42.85, -2.67], '02': [38.83, -1.98], '03': [38.48, -0.57], '04': [37.17, -2.33], '05': [40.57, -4.93], '06': [38.71, -6.42],
  '07': [39.57, 2.9], '08': [41.73, 1.98], '09': [42.37, -3.59], '10': [39.71, -6.16], '11': [36.55, -5.76], '12': [40.24, -0.15],
  '13': [38.92, -3.82], '14': [37.99, -4.81], '15': [43.13, -8.43], '16': [39.9, -2.19], '17': [42.13, 2.67], '18': [37.31, -3.27],
  '19': [40.82, -2.62], '20': [43.15, -2.2], '21': [37.57, -6.83], '22': [42.2, -0.07], '23': [37.96, -3.44], '24': [42.61, -5.84],
  '25': [42.05, 1.05], '26': [42.28, -2.52], '27': [43.0, -7.56], '28': [40.5, -3.71], '29': [36.81, -4.72], '30': [38.0, -1.5],
  '31': [42.67, -1.65], '32': [42.2, -7.59], '33': [43.29, -5.99], '34': [42.37, -4.53], '35': [28.4, -14.9], '36': [42.43, -8.46],
  '37': [40.8, -6.06], '38': [28.29, -17.2], '39': [43.2, -4.03], '40': [41.17, -4.05], '41': [37.43, -5.68], '42': [41.62, -2.59],
  '43': [41.06, 0.83], '44': [40.66, -0.82], '45': [39.79, -4.15], '46': [39.37, -0.79], '47': [41.63, -4.85], '48': [43.24, -2.85],
  '49': [41.73, -6.0], '50': [41.62, -1.06], '51': [35.89, -5.32], '52': [35.29, -2.94]
};
function provincesNear(lat, lon, n = 2) {
  return Object.entries(PROVINCES).map(([c, [a, b]]) => [c, distKm(lat, lon, a, b)]).sort((x, y) => x[1] - y[1]).slice(0, n).map(x => x[0]);
}

async function fuelStationsNear(env, lat, lon) {
  const provs = provincesNear(lat, lon, 2);
  const res = await Promise.allSettled(provs.map(p => fuelStations(env, p)));
  const ok = res.filter(r => r.status === 'fulfilled').map(r => r.value);
  if (!ok.length) throw res[0].reason;
  const seen = new Set();
  return { date: ok[0].date, list: ok.flatMap(r => r.list).filter(s => !seen.has(s.id) && seen.add(s.id)) };
}

async function fuelStations(env, prov) {
  prov = prov || env.PROVINCE || '43';
  const ck = 'fuel_cache_' + prov;
  const row = await env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind(ck).first();
  if (row) {
    const c = JSON.parse(row.v);
    if (Date.now() - c.at < 3600e3) return c;
  }
  let res;
  try {
    res = await fetch(FUEL_API + prov, {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (FiestaSTGaraje)' },
      cf: { cacheTtl: 1800 }
    });
  } catch (e) { res = null; }
  if (!res || !res.ok) {
    if (row) return JSON.parse(row.v);
    throw httpError('El servicio de precios del Ministerio no responde ahora mismo', 502);
  }
  const j = await res.json();
  const n = v => { const x = parseFloat(String(v || '').replace(',', '.')); return isNaN(x) ? null : x; };
  const list = (j.ListaEESSPrecio || []).map(s => ({
    id: s.IDEESS,
    name: String(s['Rótulo'] || 'Gasolinera').trim(),
    address: String(s['Dirección'] || '').trim(),
    town: String(s.Localidad || s.Municipio || '').trim(),
    hours: s.Horario || '',
    lat: n(s.Latitud), lon: n(s['Longitud (WGS84)']),
    p95: n(s[FUEL_FIELDS['95']]), p98: n(s[FUEL_FIELDS['98']])
  })).filter(s => s.lat && s.lon && (s.p95 || s.p98));
  if (!list.length) throw httpError('El Ministerio no ha devuelto gasolineras', 502);
  const c = { at: Date.now(), date: j.Fecha || null, list };
  await env.DB.prepare('INSERT OR REPLACE INTO kv VALUES (?, ?)').bind(ck, JSON.stringify(c)).run();
  return c;
}

async function userFuelType(env) {
  const r = await env.DB.prepare("SELECT v FROM kv WHERE k = 'fuel_type'").first();
  return r ? r.v : (env.FUEL_TYPE || '95');
}

async function nearbyFuel(env, qs) {
  const type = qs.get('type') === '98' ? '98' : '95';
  if (qs.get('type')) await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('fuel_type', ?)").bind(type).run(); // la que usas, para los precios automáticos
  let lat = parseFloat(qs.get('lat')), lon = parseFloat(qs.get('lon'));
  if (isNaN(lat) || isNaN(lon)) {
    const last = await env.DB.prepare('SELECT data FROM snapshots ORDER BY ts DESC LIMIT 1').first();
    const loc = last && JSON.parse(last.data).location;
    if (!loc) throw httpError('No hay ubicación para buscar gasolineras', 400);
    lat = loc.lat; lon = loc.lon;
  }
  const radius = Math.min(30, Math.max(1, parseFloat(qs.get('radius')) || 10));
  const { date, list } = await fuelStationsNear(env, lat, lon);
  const key = 'p' + type;
  const near = list.map(s => ({ ...s, km: round(distKm(lat, lon, s.lat, s.lon), 1), price: s[key] }))
    .filter(s => s.price && s.km <= radius);
  const byPrice = near.slice().sort((a, b) => a.price - b.price || a.km - b.km);
  const nearest = near.slice().sort((a, b) => a.km - b.km)[0] || null;
  const avg = near.length ? round(near.reduce((s, x) => s + x.price, 0) / near.length, 3) : null;
  const fav = await favStation(env, type, lat, lon);
  return { type, date, radius_km: radius, count: near.length, avg, nearest, stations: byPrice.slice(0, 12), fav };
}

// Gasolinera habitual: se muestra siempre con su precio de hoy, estés donde estés
async function favStation(env, type, lat, lon) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'fav_station'").first();
  if (!row) return null;
  const f = JSON.parse(row.v);
  try {
    const { list } = await fuelStations(env, f.prov);
    const s = list.find(x => x.id === f.id);
    if (!s) return { ...f, missing: true };
    const key = 'p' + type;
    return { ...s, prov: f.prov, price: s[key], km: lat != null ? round(distKm(lat, lon, s.lat, s.lon), 1) : null };
  } catch (e) { return { ...f, missing: true }; }
}

async function setFavStation(env, b) {
  if (!b || !b.id) { await env.DB.prepare("DELETE FROM kv WHERE k = 'fav_station'").run(); return { fav: null }; }
  const lat = Number(b.lat), lon = Number(b.lon);
  const f = { id: String(b.id), name: String(b.name || '').slice(0, 60), town: String(b.town || '').slice(0, 60), lat, lon, prov: provincesNear(lat, lon, 1)[0] };
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('fav_station', ?)").bind(JSON.stringify(f)).run();
  return { fav: f };
}

async function currentOdo(env) {
  const r = await env.DB.prepare('SELECT odometer FROM snapshots ORDER BY ts DESC LIMIT 1').first();
  return r ? r.odometer : null;
}

function maintStatus(i, odo, now) {
  const out = { ...i, next_km: null, rem_km: null, next_date: null, rem_days: null, pct: 0, status: 'sin datos', summary: 'Pon cuándo se hizo por última vez' };
  const parts = [];
  if (i.interval_km && i.last_km != null) {
    out.next_km = i.last_km + i.interval_km;
    out.rem_km = odo != null ? Math.round(out.next_km - odo) : null;
    if (out.rem_km != null) {
      out.pct = Math.max(out.pct, 1 - out.rem_km / i.interval_km);
      parts.push(out.rem_km >= 0 ? `quedan ${fmt(out.rem_km)} km` : `pasado ${fmt(-out.rem_km)} km`);
    }
  }
  if (i.interval_months && i.last_date) {
    const d = new Date(i.last_date + 'T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() + i.interval_months);
    out.next_date = d.toISOString().slice(0, 10);
    out.rem_days = Math.round((d - now) / 86400e3);
    out.pct = Math.max(out.pct, 1 - out.rem_days / (i.interval_months * 30.4));
    parts.push(out.rem_days >= 0 ? `quedan ${out.rem_days} días` : `pasado ${-out.rem_days} días`);
  }
  if (parts.length) {
    const late = (out.rem_km != null && out.rem_km <= 0) || (out.rem_days != null && out.rem_days <= 0);
    const soon = (out.rem_km != null && out.rem_km <= 1000) || (out.rem_days != null && out.rem_days <= 30);
    out.status = late ? 'vencido' : soon ? 'pronto' : 'ok';
    out.summary = parts.join(' · ');
  }
  out.pct = Math.max(0, Math.min(1, out.pct));
  return out;
}

// km al día: media de los últimos 30 días (mínimo 7 días de cuenta para no exagerar con un viaje largo)
async function kmPerDay(env) {
  const now = Date.now();
  const r = await env.DB.prepare('SELECT MIN(ts) t0, MIN(odometer) o0, MAX(odometer) o1 FROM snapshots WHERE ts > ? AND odometer IS NOT NULL').bind(now - 30 * 86400e3).first();
  if (!r || r.o0 == null) return null;
  const days = Math.max(7, (now - r.t0) / 86400e3);
  return round((r.o1 - r.o0) / days, 1);
}
// Vida del aceite: km por cada 1 % que baja, con los cambios de % vistos (hacen falta al menos 2)
async function oilRate(env) {
  const { results } = await env.DB.prepare("SELECT json_extract(data,'$.oil_life_pct') o, MIN(odometer) km FROM snapshots WHERE json_extract(data,'$.oil_life_pct') IS NOT NULL GROUP BY o ORDER BY km").all();
  if (results.length < 3) return null; // el primer % visto puede estar a medias
  const a = results[1], b = results[results.length - 1];
  const drop = a.o - b.o;
  return drop > 0 && b.km > a.km ? round((b.km - a.km) / drop, 0) : null;
}
function etaDate(days) { return days == null || !isFinite(days) ? null : new Date(Date.now() + days * 86400e3 + 3600e3).toISOString().slice(0, 10); }

async function listMaint(env) {
  const odo = await currentOdo(env);
  const kpd = await kmPerDay(env);
  const oRate = await oilRate(env);
  const { results } = await env.DB.prepare('SELECT * FROM maintenance ORDER BY id').all();
  const now = Date.now();
  const order = { vencido: 0, pronto: 1, ok: 2, 'sin datos': 3 };
  const lastSnap = await env.DB.prepare('SELECT data FROM snapshots ORDER BY ts DESC LIMIT 1').first();
  const oilLife = lastSnap ? JSON.parse(lastSnap.data).oil_life_pct : null;
  const items = (await Promise.all(results.map(i => brakeWear(env, i, odo)))).map(i => {
    let o = maintStatus(i, odo, now);
    if (oilLife != null && /aceite/i.test(i.name)) {
      // El coche calcula la vida del aceite con cómo conduces: manda sobre los km fijos
      const st = oilLife <= 10 ? 'vencido' : oilLife <= 25 ? 'pronto' : 'ok';
      o = { ...o, pct: Math.max(o.pct || 0, 100 - oilLife), status: order[st] < order[o.status] ? st : o.status, oil_life: oilLife,
        summary: `Vida del aceite según el coche: ${oilLife} %` + (o.summary && o.status !== 'sin datos' ? ' · ' + o.summary : '') };
    }
    // Fecha estimada: lo que llegue antes, los km al ritmo de uso o la fecha fija
    let byKm = o.rem_km != null && kpd > 1 ? Math.max(0, o.rem_km / kpd) : null;
    if (o.oil_life != null && oRate && kpd > 1) { const k = Math.max(0, (o.oil_life - 10) * oRate); byKm = Math.min(byKm ?? Infinity, k / kpd); o.oil_km_left = Math.round(k); }
    const days = [byKm, o.rem_days].filter(x => x != null).reduce((a, b) => Math.min(a, b), Infinity);
    o.eta = isFinite(days) ? etaDate(days) : null;
    const orig = results.find(r => r.id === i.id);
    return { ...o, last_km: orig.last_km, last_date: orig.last_date };
  }).sort((a, b) => order[a.status] - order[b.status] || b.pct - a.pct);
  return { odometer: odo, km_per_day: kpd, oil_km_per_pct: oRate, items };
}

async function saveMaint(env, b) {
  const name = String(b.name || '').trim().slice(0, 60);
  if (!name) throw httpError('Ponle un nombre a la tarea', 400);
  const num = v => (v === '' || v == null ? null : Number(v));
  const ikm = num(b.interval_km), imo = num(b.interval_months), lkm = num(b.last_km);
  if ([ikm, imo, lkm].some(v => v !== null && !(v >= 0))) throw httpError('Hay algún número no válido', 400);
  if (!ikm && !imo) throw httpError('Pon cada cuántos km o meses se hace', 400);
  const ld = b.last_date && /^\d{4}-\d{2}-\d{2}$/.test(b.last_date) ? b.last_date : null;
  const notes = b.notes ? String(b.notes).slice(0, 300) : null;
  if (b.id) {
    await env.DB.prepare('UPDATE maintenance SET name=?, interval_km=?, interval_months=?, last_km=?, last_date=?, notes=? WHERE id=?')
      .bind(name, ikm, imo, lkm, ld, notes, b.id).run();
  } else {
    await env.DB.prepare('INSERT INTO maintenance (name, interval_km, interval_months, last_km, last_date, notes) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(name, ikm, imo, lkm, ld, notes).run();
  }
  return listMaint(env);
}

async function doneMaint(env, id) {
  const odo = await currentOdo(env);
  const today = new Date(Date.now() + 3600e3).toISOString().slice(0, 10);
  await env.DB.prepare('UPDATE maintenance SET last_km = ?, last_date = ? WHERE id = ?').bind(odo, today, id).run();
  return listMaint(env);
}

async function deleteMaint(env, id) {
  await env.DB.prepare('DELETE FROM maintenance WHERE id = ?').bind(id).run();
  return listMaint(env);
}

// ---------- Avisos push (Web Push con VAPID, cifrado aes128gcm) ----------

const te = new TextEncoder();
const b64u = {
  enc: buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: s => {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Uint8Array.from(atob(s), ch => ch.charCodeAt(0));
  }
};
const concat = (...arrs) => {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

async function vapidKeys(env) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'vapid'").first();
  if (row) {
    const v = JSON.parse(row.v);
    return { pub: v.pub, priv: await crypto.subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) };
  }
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pub = b64u.enc(await crypto.subtle.exportKey('raw', kp.publicKey));
  await env.DB.prepare("INSERT OR IGNORE INTO kv VALUES ('vapid', ?)").bind(JSON.stringify({ jwk, pub })).run();
  const again = await env.DB.prepare("SELECT v FROM kv WHERE k = 'vapid'").first();
  const v = JSON.parse(again.v);
  return { pub: v.pub, priv: await crypto.subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) };
}

async function encryptPush(sub, payload) {
  const uaPub = b64u.dec(sub.keys.p256dh);
  const auth = b64u.dec(sub.keys.auth);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const prkKey = await hmac(auth, shared);
  const ikm = (await hmac(prkKey, concat(te.encode('WebPush: info\0'), uaPub, asPub, new Uint8Array([1])))).slice(0, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(te.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(te.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(te.encode(payload), new Uint8Array([2]))));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = 65;
  return concat(header, asPub, ct);
}

async function vapidAuth(env, endpoint) {
  const { pub, priv } = await vapidKeys(env);
  const h = b64u.enc(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const p = b64u.enc(te.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: PUSH_SUBJECT })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, te.encode(h + '.' + p));
  return `vapid t=${h}.${p}.${b64u.enc(sig)}, k=${pub}`;
}

async function subscribe(env, sub) {
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) {
    throw httpError('Suscripción no válida', 400);
  }
  await env.DB.prepare('INSERT OR REPLACE INTO push_subs VALUES (?, ?, ?)')
    .bind(sub.endpoint, JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys }), Date.now()).run();
  return { ok: true };
}

async function sendPushAll(env, note) {
  const { results } = await env.DB.prepare('SELECT endpoint, sub FROM push_subs').all();
  let sent = 0, failed = 0;
  for (const r of results) {
    const sub = JSON.parse(r.sub);
    try {
      const body = await encryptPush(sub, JSON.stringify(note));
      const res = await fetch(sub.endpoint, {
        method: 'POST',
        headers: {
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: '86400',
          Urgency: note.urgent ? 'high' : 'normal',
          Authorization: await vapidAuth(env, sub.endpoint)
        },
        body
      });
      if (res.status === 404 || res.status === 410) {
        await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(r.endpoint).run();
        failed++;
      } else if (res.ok) sent++;
      else { failed++; console.error('push', res.status, await res.text()); }
    } catch (e) { failed++; console.error('push', e); }
  }
  return { sent, failed, devices: results.length };
}

// ---------- Utilidades ----------

function round(v, d = 0) { const f = 10 ** d; return Math.round(v * f) / f; }
function fmt(v, d = 0) { return Number(v).toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d }); }
function clampInt(v, min, max, def) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; }
function httpError(msg, status) { const e = new Error(msg); e.status = status; return e; }

function json(data, status = 200) {
  return cors(new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json; charset=utf-8' }
  }));
}

function cors(res) {
  res.headers.set('Access-Control-Allow-Origin', '*');
  res.headers.set('Access-Control-Allow-Headers', 'x-app-key, content-type');
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  return res;
}
