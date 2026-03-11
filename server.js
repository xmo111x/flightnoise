const express = require('express');
const path = require('path');
const os = require('os');

// ── Konfiguration ──────────────────────────────────────────────
const CONFIG = {
  HOME_LAT: 48.7758, // Deine Koordinaten hier eintragen
  HOME_LON: 9.1829, // Beispiel: Stuttgart Mitte
  SCAN_RADIUS_KM: 75,       // Scan-Radius für API-Abfragen
  NOISE_RADIUS_KM: 5,       // Radius in dem Fluglärm hörbar ist
  WARNING_SECONDS: 120,      // Vorwarnzeit in Sekunden
  POLL_INTERVAL_MS: 10000,   // API-Abfrage alle 10 Sekunden
  PORT: 3000,
  MIN_ALTITUDE_M: 50,        // Unter 50m = am Boden
  MAX_ALTITUDE_M: 4000,      // Über 4000m = Reiseflughöhe, kaum Lärm
  NTFY_COOLDOWN_S: 120,      // Mindestabstand zwischen Notifications in Sekunden
};

// ── State ──────────────────────────────────────────────────────
let currentAlerts = [];
let nextExpected = null;
let lastUpdate = null;
let lastSource = null;
let sseClients = [];
let consecutiveErrors = 0;
let ntfyTopics = new Set();    // Registrierte ntfy.sh Topics (pro Device)
let lastNotificationTime = 0;
let previousOverallStatus = 'clear';

// ── Express Setup ──────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── SSE Endpoint ───────────────────────────────────────────────
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Sofort aktuellen Status senden
  const msg = JSON.stringify({
    type: 'update',
    alerts: currentAlerts,
    nextExpected,
    lastUpdate,
    source: lastSource,
    config: { noiseRadius: CONFIG.NOISE_RADIUS_KM },
  });
  res.write(`data: ${msg}\n\n`);

  sseClients.push(res);
  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
  });
});

// Status-Endpoint für einmalige Abfrage
app.get('/api/status', (_req, res) => {
  res.json({
    alerts: currentAlerts,
    lastUpdate,
    source: lastSource,
    config: { noiseRadius: CONFIG.NOISE_RADIUS_KM, ntfyTopics: ntfyTopics.size },
  });
});

// ntfy-Topics verwalten (pro Device)
app.get('/api/ntfy', (req, res) => {
  const topic = (req.query.topic || '').trim();
  if (topic) {
    res.json({ topic, active: ntfyTopics.has(topic) });
  } else {
    res.json({ count: ntfyTopics.size });
  }
});

app.post('/api/ntfy', (req, res) => {
  const topic = (req.body.topic || '').trim();
  const oldTopic = (req.body.oldTopic || '').trim();

  // Altes Topic entfernen
  if (oldTopic && oldTopic !== topic) {
    ntfyTopics.delete(oldTopic);
  }

  if (topic) {
    ntfyTopics.add(topic);
    console.log(`[${timestamp()}] Push-Topic registriert: ntfy.sh/${topic} (${ntfyTopics.size} aktiv)`);
  } else if (oldTopic) {
    console.log(`[${timestamp()}] Push-Topic entfernt: ntfy.sh/${oldTopic} (${ntfyTopics.size} aktiv)`);
  }

  res.json({ topic, active: !!topic, totalTopics: ntfyTopics.size });
});

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => {
    try { client.write(msg); } catch (_) { /* client disconnected */ }
  });
}

// ── Geo-Mathematik ─────────────────────────────────────────────
function toRad(deg) { return deg * Math.PI / 180; }

function predictOverflight(lat_a, lon_a, heading, speed, altitude) {
  const R = 6371000;
  const lat_h = CONFIG.HOME_LAT;
  const lon_h = CONFIG.HOME_LON;

  // Flugzeugposition relativ zum Haus (lokale kartesische Koordinaten in Metern)
  const avgLatRad = toRad((lat_a + lat_h) / 2);
  const x = toRad(lon_a - lon_h) * R * Math.cos(avgLatRad); // Ost
  const y = toRad(lat_a - lat_h) * R;                        // Nord

  // Geschwindigkeitsvektor (Heading = Grad im Uhrzeigersinn von Nord)
  const headingRad = toRad(heading);
  const vx = speed * Math.sin(headingRad);
  const vy = speed * Math.cos(headingRad);

  const speedSq = vx * vx + vy * vy;
  if (speedSq < 1) return null; // steht still

  // Zeitpunkt der nächsten Annäherung
  // P(t) = (x + vx*t, y + vy*t), minimiere |P(t)|²
  const t_closest = -(vx * x + vy * y) / speedSq;

  // Geringste Distanz zum Haus
  const cx = x + vx * t_closest;
  const cy = y + vy * t_closest;
  const closest_distance = Math.sqrt(cx * cx + cy * cy);
  const current_distance = Math.sqrt(x * x + y * y);

  // Eintritts- und Austrittszeit aus der Lärmzone berechnen
  const noiseRadius = CONFIG.NOISE_RADIUS_KM * 1000;
  let t_enter = null;
  let t_exit = null;

  if (closest_distance < noiseRadius) {
    const halfChord = Math.sqrt(noiseRadius * noiseRadius - closest_distance * closest_distance);
    const totalSpeed = Math.sqrt(speedSq);
    t_enter = t_closest - halfChord / totalSpeed;
    t_exit = t_closest + halfChord / totalSpeed;
  }

  return {
    t_closest,
    closest_distance,
    current_distance,
    t_enter,
    t_exit,
    approaching: t_closest > 0,
  };
}

// ── Datenquellen ───────────────────────────────────────────────

// Primär: adsb.lol (kostenlos, community-driven)
async function fetchFromAdsbLol() {
  const distNM = Math.ceil(CONFIG.SCAN_RADIUS_KM / 1.852);
  const url = `https://api.adsb.lol/v2/lat/${CONFIG.HOME_LAT}/lon/${CONFIG.HOME_LON}/dist/${distNM}`;

  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`adsb.lol HTTP ${response.status}`);
  const data = await response.json();

  return (data.ac || []).map(ac => ({
    icao: ac.hex || 'unknown',
    callsign: (ac.flight || ac.r || ac.hex || '').trim(),
    lat: ac.lat,
    lon: ac.lon,
    altitude: ac.alt_baro === 'ground' ? 0 : ((ac.alt_baro || ac.alt_geom || null)),
    altFeet: true,
    speed: ac.gs,
    speedKnots: true,
    heading: ac.track,
    onGround: ac.alt_baro === 'ground',
    type: ac.t || null,
    registration: ac.r || null,
  })).filter(ac => ac.lat != null && ac.lon != null);
}

// Fallback: OpenSky Network
async function fetchFromOpenSky() {
  const latDelta = CONFIG.SCAN_RADIUS_KM / 111.32;
  const lonDelta = CONFIG.SCAN_RADIUS_KM / (111.32 * Math.cos(toRad(CONFIG.HOME_LAT)));

  const params = new URLSearchParams({
    lamin: (CONFIG.HOME_LAT - latDelta).toFixed(4),
    lamax: (CONFIG.HOME_LAT + latDelta).toFixed(4),
    lomin: (CONFIG.HOME_LON - lonDelta).toFixed(4),
    lomax: (CONFIG.HOME_LON + lonDelta).toFixed(4),
  });

  const url = `https://opensky-network.org/api/states/all?${params}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`OpenSky HTTP ${response.status}`);
  const data = await response.json();

  return (data.states || []).map(s => ({
    icao: s[0],
    callsign: (s[1] || s[0] || '').trim(),
    lat: s[6],
    lon: s[5],
    altitude: s[7] || s[13],
    altFeet: false,
    speed: s[9],
    speedKnots: false,
    heading: s[10],
    onGround: s[8],
    type: null,
    registration: null,
  })).filter(ac => ac.lat != null && ac.lon != null);
}

async function fetchAircraft() {
  // adsb.lol zuerst, dann OpenSky als Fallback
  try {
    const result = await fetchFromAdsbLol();
    lastSource = 'adsb.lol';
    return result;
  } catch (e) {
    console.warn(`[${timestamp()}] adsb.lol fehlgeschlagen: ${e.message}`);
  }

  try {
    const result = await fetchFromOpenSky();
    lastSource = 'OpenSky';
    return result;
  } catch (e) {
    console.warn(`[${timestamp()}] OpenSky fehlgeschlagen: ${e.message}`);
  }

  return null;
}

// ── Verarbeitung ───────────────────────────────────────────────
function processAircraft(aircraft) {
  const alerts = [];

  for (const ac of aircraft) {
    if (ac.onGround) continue;
    if (ac.heading === null || ac.heading === undefined) continue;
    if (ac.speed === null || ac.speed === undefined) continue;

    // Einheiten normalisieren
    let altitude = ac.altitude;
    if (altitude != null && ac.altFeet) altitude *= 0.3048;

    let speed = ac.speed;
    if (ac.speedKnots) speed *= 0.514444;

    // Höhenfilter: zu niedrig (Boden) oder zu hoch (Reiseflug = kein Lärm)
    if (altitude != null && altitude < CONFIG.MIN_ALTITUDE_M) continue;
    if (altitude != null && altitude > CONFIG.MAX_ALTITUDE_M) continue;

    const prediction = predictOverflight(ac.lat, ac.lon, ac.heading, speed, altitude);
    if (!prediction) continue;

    // Nur Flugzeuge, die durch die Lärmzone fliegen
    if (prediction.closest_distance > CONFIG.NOISE_RADIUS_KM * 1000) continue;

    // Bereits vorbei?
    if (prediction.t_exit !== null && prediction.t_exit < -5) continue;

    // Status bestimmen
    let status;
    if (prediction.t_enter !== null && prediction.t_enter > 0) {
      status = 'approaching';
    } else if (prediction.t_exit !== null && prediction.t_exit > 0) {
      status = 'overhead';
    } else {
      continue;
    }

    // Nur warnen wenn innerhalb der Vorwarnzeit
    if (status === 'approaching' && prediction.t_enter > CONFIG.WARNING_SECONDS) continue;

    alerts.push({
      icao: ac.icao,
      callsign: ac.callsign || ac.icao,
      altitude: altitude ? Math.round(altitude) : null,
      speed: speed ? Math.round(speed * 3.6) : null, // in km/h
      status,
      secondsUntilNoise: status === 'approaching' ? Math.round(prediction.t_enter) : 0,
      secondsUntilClear: prediction.t_exit != null ? Math.round(prediction.t_exit) : null,
      closestDistance: Math.round(prediction.closest_distance),
      currentDistance: Math.round(prediction.current_distance),
      heading: Math.round(ac.heading),
      type: ac.type,
      timestamp: Date.now(),
    });
  }

  // Sortieren: overhead zuerst, dann nach Ankunftszeit
  alerts.sort((a, b) => {
    if (a.status === 'overhead' && b.status !== 'overhead') return -1;
    if (a.status !== 'overhead' && b.status === 'overhead') return 1;
    return (a.secondsUntilNoise || 0) - (b.secondsUntilNoise || 0);
  });

  return alerts;
}

// ── Nächstes erwartetes Flugzeug (STR-Anflüge) ──────────────────
async function findUpcoming(aircraft) {
  // Kandidaten sammeln: alle Flugzeuge die nicht am Boden sind
  const candidates = aircraft.filter(ac =>
    !ac.onGround && ac.lat != null && ac.lon != null &&
    (ac.callsign || ac.icao)
  );

  if (candidates.length === 0) return null;

  // Route-API abfragen für alle Kandidaten
  const routePayload = candidates.map(ac => ({
    callsign: (ac.callsign || ac.icao || '').trim(),
    hex: ac.icao || '',
    lat: ac.lat,
    lng: ac.lon,
  }));

  let routes;
  try {
    const res = await fetch('https://api.adsb.lol/api/0/routeset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planes: routePayload }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    routes = await res.json();
  } catch (e) {
    return null;
  }

  // STR-Anflüge finden (Ziel = STR/EDDS)
  const strCallsigns = new Map();
  for (const route of routes) {
    const iata = (route._airport_codes_iata || '').split('-');
    const icao = (route.airport_codes || '').split('-');
    const dest_iata = iata[iata.length - 1];
    const dest_icao = icao[icao.length - 1];
    if (dest_iata === 'STR' || dest_icao === 'EDDS') {
      strCallsigns.set(route.callsign, route._airport_codes_iata);
    }
  }

  if (strCallsigns.size === 0) return null;

  // STR-Flughafen Position
  const STR_LAT = 48.6899;
  const STR_LON = 9.2220;

  let best = null;

  for (const ac of candidates) {
    const callsign = (ac.callsign || ac.icao || '').trim();
    if (!strCallsigns.has(callsign)) continue;

    let speed = ac.speed;
    if (ac.speedKnots) speed *= 0.514444;
    if (!speed || speed < 10) continue;

    let altitude = ac.altitude;
    if (altitude != null && ac.altFeet) altitude *= 0.3048;

    // Entfernung zum Flughafen STR berechnen
    const R = 6371000;
    const dLat = toRad(STR_LAT - ac.lat);
    const dLon = toRad(STR_LON - ac.lon);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(ac.lat)) * Math.cos(toRad(STR_LAT)) * Math.sin(dLon/2)**2;
    const distToSTR = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

    // Entfernung zum Haus
    const dLat2 = toRad(CONFIG.HOME_LAT - ac.lat);
    const dLon2 = toRad(CONFIG.HOME_LON - ac.lon);
    const a2 = Math.sin(dLat2/2)**2 + Math.cos(toRad(ac.lat)) * Math.cos(toRad(CONFIG.HOME_LAT)) * Math.sin(dLon2/2)**2;
    const distToHome = R * 2 * Math.atan2(Math.sqrt(a2), Math.sqrt(1-a2));

    // Geschätzte Ankunftszeit basierend auf Entfernung zum Haus
    const etaSeconds = Math.round(distToHome / speed);

    // Nur Flugzeuge die noch >30s entfernt sind
    if (etaSeconds <= 30) continue;

    if (!best || etaSeconds < best.secondsUntilNoise) {
      best = {
        callsign,
        route: strCallsigns.get(callsign),
        altitude: altitude ? Math.round(altitude) : null,
        secondsUntilNoise: etaSeconds,
        currentDistance: Math.round(distToHome),
        type: ac.type,
      };
    }
  }

  return best;
}

// ── Push-Notifications (ntfy.sh) ───────────────────────────────
async function sendPushNotification(alerts) {
  if (ntfyTopics.size === 0) return;

  const now = Date.now();
  const approaching = alerts.filter(a => a.status === 'approaching');
  const overhead = alerts.filter(a => a.status === 'overhead');
  const currentStatus = overhead.length > 0 ? 'overhead' : (approaching.length > 0 ? 'approaching' : 'clear');

  // Nur senden wenn Status von "clear" auf "approaching" wechselt UND Cooldown abgelaufen
  if (currentStatus === 'clear' || previousOverallStatus !== 'clear') {
    previousOverallStatus = currentStatus;
    return;
  }

  if (now - lastNotificationTime < CONFIG.NTFY_COOLDOWN_S * 1000) {
    previousOverallStatus = currentStatus;
    return;
  }

  previousOverallStatus = currentStatus;
  lastNotificationTime = now;

  const first = approaching[0] || overhead[0];
  const seconds = first.secondsUntilNoise || 0;
  const title = 'Flugzeug naehert sich!';
  const body = seconds > 0
    ? `${first.callsign} in ca. ${seconds} Sekunden (${first.altitude || '?'}m Höhe)`
    : `${first.callsign} ist über euch (${first.altitude || '?'}m Höhe)`;

  // An alle registrierten Topics senden
  const promises = [...ntfyTopics].map(topic =>
    fetch(`https://ntfy.sh/${topic}`, {
      method: 'POST',
      headers: {
        'Title': title,
        'Priority': overhead.length > 0 ? '5' : '4',
        'Tags': 'airplane',
        'Click': `http://${getLocalIP()}:${CONFIG.PORT}`,
      },
      body: body,
    }).catch(e => {
      console.warn(`[${timestamp()}] ntfy-Fehler (${topic}): ${e.message}`);
    })
  );

  await Promise.allSettled(promises);
  console.log(`[${timestamp()}] Push an ${ntfyTopics.size} Topic(s) gesendet: ${body}`);
}

// ── Update-Loop ────────────────────────────────────────────────
async function updateLoop() {
  try {
    const aircraft = await fetchAircraft();
    if (aircraft !== null) {
      consecutiveErrors = 0;
      currentAlerts = processAircraft(aircraft);
      nextExpected = await findUpcoming(aircraft);
      lastUpdate = new Date().toISOString();

      const total = aircraft.length;
      const alertCount = currentAlerts.length;
      if (alertCount > 0) {
        console.log(`[${timestamp()}] ${total} Flugzeuge gescannt, ${alertCount} Alarm(e) aktiv [${lastSource}]`);
        currentAlerts.forEach(a => {
          const info = a.status === 'approaching'
            ? `nähert sich, in ${a.secondsUntilNoise}s`
            : `über uns, noch ${a.secondsUntilClear}s`;
          console.log(`  ✈ ${a.callsign} – ${info} (${(a.currentDistance/1000).toFixed(1)} km, ${a.altitude || '?'}m)`);
        });
      }

      broadcast({
        type: 'update',
        alerts: currentAlerts,
        nextExpected,
        lastUpdate,
        source: lastSource,
      });

      // Push-Notification senden
      sendPushNotification(currentAlerts);
    } else {
      consecutiveErrors++;
      console.error(`[${timestamp()}] Keine Daten verfügbar (Fehler #${consecutiveErrors})`);
      broadcast({ type: 'error', message: 'Keine Flugdaten verfügbar' });
    }
  } catch (err) {
    consecutiveErrors++;
    console.error(`[${timestamp()}] Update-Fehler: ${err.message}`);
  }

  // Backoff bei Fehlern (max 60 Sekunden)
  const delay = Math.min(CONFIG.POLL_INTERVAL_MS * (1 + consecutiveErrors * 0.5), 60000);
  setTimeout(updateLoop, delay);
}

// ── Hilfsfunktionen ────────────────────────────────────────────
function timestamp() {
  return new Date().toLocaleTimeString('de-DE');
}

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// ── Server starten ─────────────────────────────────────────────
app.listen(CONFIG.PORT, '0.0.0.0', () => {
  const localIP = getLocalIP();
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║           ✈  FlugWarner gestartet  ✈            ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Lokal:    http://localhost:${CONFIG.PORT}`);
  console.log(`║  Netzwerk: http://${localIP}:${CONFIG.PORT}`);
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Position: ${CONFIG.HOME_LAT}, ${CONFIG.HOME_LON}`);
  console.log(`║  Radius:   ${CONFIG.NOISE_RADIUS_KM} km`);
  console.log(`║  Scan:     ${CONFIG.SCAN_RADIUS_KM} km`);
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
  console.log('Öffne die Netzwerk-URL auf deinem iPhone und');
  console.log('tippe auf "Teilen → Zum Home-Bildschirm".');
  console.log('');

  updateLoop();
});
