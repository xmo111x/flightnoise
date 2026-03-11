# Flightnoise - Fluglärm-Frühwarnsystem

## Projektübersicht
Express.js-Server (Node.js), der Flugzeugdaten von adsb.lol (Fallback: OpenSky) abruft und vor Überflügen warnt. Webapp für iPhone-Homescreen optimiert.

## Architektur
- **server.js** – Backend: API-Polling, Vorhersage-Berechnung, SSE-Broadcast, Push-Notifications
- **public/index.html** – HTML-Struktur der Webapp
- **public/style.css** – Styling inkl. Dark Mode (über `body.dark` Klasse)
- **public/app.js** – Frontend-Logik: SSE-Client, Countdown, Rendering
- **public/manifest.json** – PWA-Manifest
- **public/icon-192.png / icon-512.png** – App-Icons (generiert aus icon.svg)

## Konfiguration (server.js CONFIG)
- **Position:** 48.644, 9.004 (nähe Stuttgart)
- **SCAN_RADIUS_KM:** 75 (API-Abfrage-Radius)
- **NOISE_RADIUS_KM:** 5 (Lärmzone)
- **WARNING_SECONDS:** 120 (Vorwarnzeit)
- **MIN_ALTITUDE_M:** 50, **MAX_ALTITUDE_M:** 4000
- **PORT:** 3000
- Push-Notifications via ntfy.sh

## Datenquellen
- **Primär:** adsb.lol v2 API (`/v2/lat/.../lon/.../dist/...`)
- **Fallback:** OpenSky Network
- **Routen:** adsb.lol routeset API (`/api/0/routeset`) – liefert Abflug/Ziel-Flughäfen (z.B. CPH-STR)

## Wichtige Features
- SSE (Server-Sent Events) für Echtzeit-Updates
- Status: clear (grün) → approaching (gelb) → overhead (rot)
- Client-seitige Countdown-Interpolation zwischen Server-Updates
- Direkter Übergang gelb→rot (kein grüner Zwischenzustand) via Client-Logik
- Dark Mode Toggle (localStorage-gespeichert)
- Push-Notifications via ntfy.sh mit Click-URL zum Öffnen der Webapp
- ntfy Title darf kein Unicode/Emoji enthalten (HTTP-Header-Limitation), stattdessen `Tags: airplane`
- **nextExpected** (aktuell deaktiviert): Zeigt nächsten STR-Anflug basierend auf adsb.lol routeset API

## Server starten
```bash
node server.js
# oder: npm start
```
Erreichbar unter http://localhost:3000 und im Netzwerk.

## Bekannte Hinweise
- Nach Server-Neustart muss der ntfy-Topic im Browser neu aktiviert werden (wird nur im Speicher gehalten)
- Icon wird auf iPhone erst nach erneutem "Zum Home-Bildschirm hinzufügen" aktualisiert
