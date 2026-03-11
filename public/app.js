// ── State ──────────────────────────────────────────────────────
let alerts = [];
let nextExpected = null;
let localTimestamp = null;
let eventSource = null;
let soundEnabled = false;
let previousStatus = 'clear';

// ── DOM-Elemente ───────────────────────────────────────────────
const statusCircle = document.getElementById('status-circle');
const statusIcon = document.getElementById('status-icon');
const statusText = document.getElementById('status-text');
const statusCountdown = document.getElementById('status-countdown');
const flightsList = document.getElementById('flights-list');
const lastUpdateEl = document.getElementById('last-update');
const sourceInfoEl = document.getElementById('source-info');
const connectionDot = document.getElementById('connection-dot');
const btnSound = document.getElementById('btn-sound');
const soundIconEl = document.getElementById('sound-icon');

// ── SSE Verbindung ─────────────────────────────────────────────
function connect() {
  if (eventSource) eventSource.close();

  eventSource = new EventSource('/api/events');

  eventSource.onopen = () => {
    connectionDot.className = 'connected';
  };

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === 'update') {
        alerts = data.alerts || [];
        nextExpected = data.nextExpected || null;
        localTimestamp = Date.now();

        if (data.lastUpdate) {
          const d = new Date(data.lastUpdate);
          lastUpdateEl.textContent = `Letzte Prüfung: ${d.toLocaleTimeString('de-DE')}`;
        }

        if (data.source) {
          sourceInfoEl.textContent = `Datenquelle: ${data.source}`;
        }

        render();
        handleNotifications();
      }

      if (data.type === 'error') {
        sourceInfoEl.textContent = data.message || 'Fehler';
      }
    } catch (_) { /* parse error */ }
  };

  eventSource.onerror = () => {
    connectionDot.className = 'error';
  };
}

// ── Zeitberechnung ─────────────────────────────────────────────
function adjustedTimes(alert) {
  if (!localTimestamp) return { untilNoise: 0, untilClear: 0 };
  const elapsed = (Date.now() - localTimestamp) / 1000;
  return {
    untilNoise: Math.max(0, (alert.secondsUntilNoise || 0) - elapsed),
    untilClear: alert.secondsUntilClear != null
      ? Math.max(0, alert.secondsUntilClear - elapsed)
      : null,
  };
}

function formatSeconds(sec) {
  if (sec == null) return '';
  const s = Math.ceil(sec);
  if (s >= 60) {
    const m = Math.floor(s / 60);
    const rest = s % 60;
    return `${m}:${rest.toString().padStart(2, '0')}`;
  }
  return `${s}s`;
}

// ── Gesamtstatus ermitteln ─────────────────────────────────────
function overallStatus() {
  for (const a of alerts) {
    const t = adjustedTimes(a);
    if (a.status === 'overhead' && (t.untilClear === null || t.untilClear > 0)) {
      return 'overhead';
    }
    // Approaching-Countdown abgelaufen → sofort als overhead behandeln
    if (a.status === 'approaching' && t.untilNoise <= 0 && (t.untilClear === null || t.untilClear > 0)) {
      return 'overhead';
    }
  }
  for (const a of alerts) {
    const t = adjustedTimes(a);
    if (a.status === 'approaching' && t.untilNoise > 0) {
      return 'approaching';
    }
  }
  return 'clear';
}

// ── Rendering ──────────────────────────────────────────────────
function render() {
  const status = overallStatus();
  statusCircle.className = status;

  switch (status) {
    case 'clear':
      statusIcon.textContent = '✓';
      statusText.textContent = 'Alles ruhig';
      statusCountdown.textContent = '';
      document.title = 'FlugWarner – Ruhig';
      break;

    case 'approaching': {
      const first = alerts.find(a => a.status === 'approaching');
      const t = adjustedTimes(first);
      statusIcon.textContent = '✈';
      statusText.textContent = 'Flugzeug nähert sich';
      statusCountdown.textContent = formatSeconds(t.untilNoise);
      document.title = `⚠ In ${formatSeconds(t.untilNoise)} – FlugWarner`;
      break;
    }

    case 'overhead': {
      const first = alerts.find(a => a.status === 'overhead');
      const t = adjustedTimes(first);
      statusIcon.textContent = '✈';
      statusText.textContent = 'Flugzeug über uns!';
      statusCountdown.textContent = t.untilClear != null
        ? `Noch ${formatSeconds(t.untilClear)}`
        : '';
      document.title = `🔴 Laut! – FlugWarner`;
      break;
    }
  }

  renderFlightCards();
}

function renderFlightCards() {
  // Nur aktive Alarme anzeigen
  const active = alerts.filter(a => {
    const t = adjustedTimes(a);
    if (a.status === 'approaching') return t.untilNoise > 0;
    if (a.status === 'overhead') return t.untilClear === null || t.untilClear > 0;
    return false;
  });

  if (active.length === 0) {
    flightsList.innerHTML = '<div class="empty-state">Keine Flugzeuge in der Nähe</div>';
    return;
  }

  flightsList.innerHTML = active.map(a => {
    const t = adjustedTimes(a);
    const isApproaching = a.status === 'approaching';

    const timerValue = isApproaching
      ? formatSeconds(t.untilNoise)
      : (t.untilClear != null ? formatSeconds(t.untilClear) : '–');

    const timerLabel = isApproaching ? 'Kommt in' : 'Noch';

    const details = [
      a.altitude ? `${a.altitude} m` : null,
      a.speed ? `${a.speed} km/h` : null,
      `${(a.currentDistance / 1000).toFixed(1)} km entfernt`,
    ].filter(Boolean).join(' · ');

    return `
      <div class="flight-card ${a.status}">
        <div class="flight-info">
          <div class="flight-callsign">${escapeHtml(a.callsign)}</div>
          <div class="flight-details">${details}</div>
        </div>
        <div>
          <div class="flight-timer">${timerValue}</div>
          <div class="flight-timer-label">${timerLabel}</div>
        </div>
      </div>
    `;
  }).join('');
}

function renderNextExpected() {
  const el = document.getElementById('next-expected');
  const status = overallStatus();

  // Nur anzeigen wenn gerade kein Alarm aktiv ist
  if (!nextExpected || status !== 'clear') {
    el.classList.add('hidden');
    return;
  }

  const elapsed = localTimestamp ? (Date.now() - localTimestamp) / 1000 : 0;
  const secs = Math.max(0, nextExpected.secondsUntilNoise - elapsed);
  const mins = Math.ceil(secs / 60);
  const dist = (nextExpected.currentDistance / 1000).toFixed(1);

  let timeStr;
  if (mins >= 60) {
    timeStr = `ca. ${Math.round(mins / 60)} Std.`;
  } else {
    timeStr = `ca. ${mins} min`;
  }

  const details = [
    nextExpected.callsign,
    nextExpected.route || null,
    nextExpected.altitude ? `${nextExpected.altitude} m` : null,
    `${dist} km entfernt`,
  ].filter(Boolean).join(' · ');

  el.innerHTML = `
    <div class="next-label">Nächstes Flugzeug erwartet in</div>
    <div class="next-time">${timeStr}</div>
    <div class="next-detail">${escapeHtml(details)}</div>
  `;
  el.classList.remove('hidden');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── Benachrichtigungen ─────────────────────────────────────────
function handleNotifications() {
  const status = overallStatus();

  // Ton abspielen wenn ein neues Flugzeug kommt
  if (status !== 'clear' && previousStatus === 'clear' && soundEnabled) {
    playTone();
  }

  // Browser-Notification
  if (status === 'approaching' && previousStatus === 'clear') {
    if ('Notification' in window && Notification.permission === 'granted') {
      const first = alerts.find(a => a.status === 'approaching');
      if (first) {
        const t = adjustedTimes(first);
        new Notification('FlugWarner', {
          body: `${first.callsign} nähert sich – in ca. ${formatSeconds(t.untilNoise)}`,
          tag: 'flugwarner',
          renotify: true,
        });
      }
    }
  }

  previousStatus = status;
}

function playTone() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();

    // Zwei sanfte Töne
    [0, 0.2].forEach(offset => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = offset === 0 ? 523.25 : 659.25; // C5, E5
      gain.gain.setValueAtTime(0.12, ctx.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.5);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + 0.5);
    });
  } catch (_) { /* Audio nicht verfügbar */ }
}

// ── Sound Toggle ───────────────────────────────────────────────
btnSound.addEventListener('click', () => {
  soundEnabled = !soundEnabled;
  btnSound.classList.toggle('active', soundEnabled);
  soundIconEl.textContent = soundEnabled ? '🔔' : '🔕';

  // Notification-Permission anfragen
  if (soundEnabled && 'Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  // Test-Ton abspielen damit iOS AudioContext erlaubt
  if (soundEnabled) {
    playTone();
  }
});

// ── Push-Notifications (ntfy) ──────────────────────────────────
const btnPush = document.getElementById('btn-push');
const ntfyDialog = document.getElementById('ntfy-dialog');
const ntfyTopicInput = document.getElementById('ntfy-topic');
const ntfyCancel = document.getElementById('ntfy-cancel');
const ntfySave = document.getElementById('ntfy-save');
const ntfyStatus = document.getElementById('ntfy-status');

// Topic aus localStorage laden (jedes Device hat seinen eigenen)
const savedTopic = localStorage.getItem('ntfyTopic') || '';
if (savedTopic) {
  ntfyTopicInput.value = savedTopic;
  btnPush.classList.add('active');
  btnPush.innerHTML = '📲 Push an';

  // Beim Server re-registrieren (falls Server neugestartet wurde)
  fetch('/api/ntfy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: savedTopic }),
  }).catch(() => {});
}

btnPush.addEventListener('click', async () => {
  const activeTopic = localStorage.getItem('ntfyTopic') || '';

  if (activeTopic) {
    // Push ist aktiv → direkt deaktivieren
    try {
      await fetch('/api/ntfy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: '', oldTopic: activeTopic }),
      });
    } catch (_) {}
    localStorage.removeItem('ntfyTopic');
    btnPush.classList.remove('active');
    btnPush.innerHTML = '📲 Push';
  } else {
    // Push ist aus → Dialog öffnen, letzten Topic vorschlagen
    const lastTopic = localStorage.getItem('ntfyLastTopic') || '';
    if (lastTopic && !ntfyTopicInput.value.trim()) {
      ntfyTopicInput.value = lastTopic;
    }
    ntfyDialog.classList.remove('hidden');
    ntfyStatus.textContent = '';
  }
});

ntfyCancel.addEventListener('click', () => {
  ntfyDialog.classList.add('hidden');
});

ntfySave.addEventListener('click', async () => {
  const topic = ntfyTopicInput.value.trim();
  const oldTopic = localStorage.getItem('ntfyTopic') || '';

  try {
    const res = await fetch('/api/ntfy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, oldTopic }),
    });
    const data = await res.json();

    if (data.active) {
      localStorage.setItem('ntfyTopic', topic);
      localStorage.setItem('ntfyLastTopic', topic);
      ntfyStatus.style.color = 'var(--green)';
      ntfyStatus.textContent = 'Aktiviert! Abonniere "' + data.topic + '" in der ntfy App.';
      btnPush.classList.add('active');
      btnPush.innerHTML = '📲 Push an';

      // Test-Notification senden
      setTimeout(async () => {
        try {
          await fetch(`https://ntfy.sh/${data.topic}`, {
            method: 'POST',
            headers: { 'Title': 'FlugWarner Test', 'Tags': 'white_check_mark' },
            body: 'Push-Mitteilungen funktionieren!',
          });
          ntfyStatus.textContent = 'Test-Mitteilung gesendet!';
        } catch (_) {}
      }, 500);
    } else {
      localStorage.removeItem('ntfyTopic');
      ntfyStatus.style.color = 'var(--text-secondary)';
      ntfyStatus.textContent = 'Push-Mitteilungen deaktiviert.';
      btnPush.classList.remove('active');
      btnPush.innerHTML = '📲 Push';
    }

    setTimeout(() => ntfyDialog.classList.add('hidden'), 2500);
  } catch (e) {
    ntfyStatus.style.color = 'var(--red)';
    ntfyStatus.textContent = 'Fehler beim Speichern.';
  }
});

// Dialog schließen bei Tap auf Overlay
ntfyDialog.addEventListener('click', (e) => {
  if (e.target === ntfyDialog) ntfyDialog.classList.add('hidden');
});

// ── Countdown-Update jede Sekunde ──────────────────────────────
setInterval(render, 1000);

// ── Dark Mode Toggle ────────────────────────────────────────────
const darkToggle = document.getElementById('dark-toggle');

if (localStorage.getItem('darkMode') === 'true') {
  document.body.classList.add('dark');
  darkToggle.checked = true;
}

darkToggle.addEventListener('change', () => {
  document.body.classList.toggle('dark', darkToggle.checked);
  localStorage.setItem('darkMode', darkToggle.checked);
});

// ── Start ──────────────────────────────────────────────────────
connect();
