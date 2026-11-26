"""
Conecta tu cuenta de Ford con el servidor de tu app del coche.

Uso (dentro del Codespace):
    python herramientas/conectar_ford.py

Qué hace:
1. Abre el login oficial de Ford en el navegador del escritorio en la nube (puerto 6080).
2. Tú entras con tu cuenta de Ford. Tu contraseña solo la ves y la escribes tú, en la web de Ford.
3. Cuando Ford te devuelve a su app, este programa captura el código de acceso,
   lo cambia por los tokens de Ford y los envía a tu servidor de Cloudflare.
"""
from __future__ import annotations

import asyncio
import base64
import getpass
import hashlib
import json
import os
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# Constantes de la app oficial de Ford para España (las mismas que usa pyfordpass / ha-fordpass).
TENANT = '4566605f-43a7-400a-946e-89cc9fdb0bd7'
CLIENT_ID = '09852200-05fd-41f6-8c21-d36d3497dc64'
APP_ID_EU = '667D773E-1BDC-4139-8AD0-2B16474E8DC7'
LOCALE = 'es-ES'
COUNTRY = 'ESP'
POLICY = f'B2C_1A_SignInSignUp_{LOCALE}'
REDIRECT = 'fordapp://userauthorized'
UA = 'okhttp/4.12.0'
LOGIN = 'https://login.ford.com'
FOUNDATIONAL = 'https://api.foundational.ford.com'
VEHICLE = 'https://api.vehicle.ford.com'
BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
TOKENS_FILE = os.path.expanduser('~/.ford_tokens.json')


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip('=')


def http(method: str, url: str, *, headers: dict, body: bytes | None = None) -> dict:
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            text = r.read().decode()
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors='replace')[:400]
        raise SystemExit(f'\n❌ {method} {url.split("?")[0]} → {e.code}\n{detail}\n\nCópiame este error en el chat.') from None
    return json.loads(text) if text else {}


def find_vins(obj) -> list[str]:
    found = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k.lower() == 'vin' and isinstance(v, str) and len(v) == 17:
                found.append(v)
            else:
                found += find_vins(v)
    elif isinstance(obj, list):
        for v in obj:
            found += find_vins(v)
    return list(dict.fromkeys(found))


def extract_code(url: str) -> str | None:
    if not url or not url.startswith('fordapp://'):
        return None
    qs = urllib.parse.parse_qs(urllib.parse.urlparse(url.replace('fordapp://', 'https://x/', 1)).query)
    return (qs.get('code') or [None])[0]


async def capture_code(auth_url: str) -> str:
    from playwright.async_api import async_playwright

    os.environ.setdefault('DISPLAY', ':1')
    captured: asyncio.Future = asyncio.get_event_loop().create_future()

    def offer(url: str | None):
        code = extract_code(url or '')
        if code and not captured.done():
            captured.set_result(code)

    async with async_playwright() as p:
        exe = p.chromium.executable_path
        profile = '/tmp/ford-perfil'
        proc = subprocess.Popen(
            [exe, '--remote-debugging-port=9222', f'--user-data-dir={profile}', '--no-first-run',
             '--no-default-browser-check', '--no-sandbox', '--disable-dev-shm-usage',
             '--start-maximized', '--lang=es-ES', 'about:blank'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        browser = None
        for _ in range(40):
            try:
                browser = await p.chromium.connect_over_cdp('http://127.0.0.1:9222')
                break
            except Exception:
                await asyncio.sleep(0.5)
        if not browser:
            proc.kill()
            raise SystemExit('❌ No se pudo abrir el navegador. Cópiame este mensaje en el chat.')

        context = browser.contexts[0]

        async def watch(page):
            try:
                cdp = await context.new_cdp_session(page)
                await cdp.send('Network.enable')

                def on_req(params):
                    offer(params.get('request', {}).get('url'))
                    rr = params.get('redirectResponse') or {}
                    hdrs = {k.lower(): v for k, v in (rr.get('headers') or {}).items()}
                    offer(hdrs.get('location'))

                def on_resp(params):
                    hdrs = {k.lower(): v for k, v in (params.get('response', {}).get('headers') or {}).items()}
                    offer(hdrs.get('location'))

                cdp.on('Network.requestWillBeSent', on_req)
                cdp.on('Network.responseReceived', on_resp)
            except Exception:
                pass
            page.on('request', lambda r: offer(r.url))
            page.on('framenavigated', lambda f: offer(f.url))

        for pg in context.pages:
            await watch(pg)
        context.on('page', lambda pg: asyncio.ensure_future(watch(pg)))

        page = context.pages[0] if context.pages else await context.new_page()
        try:
            await page.goto(auth_url)
        except Exception:
            # Si Ford ya recuerda la sesión, redirige al instante a fordapp:// y la carga "se aborta":
            # es lo esperado, el código ya se ha capturado.
            pass
        if captured.done():
            print('🔓 Ford ha recordado tu sesión: no hace falta volver a hacer login.')

        print('\n🖥️  Abre el escritorio en otra pestaña de Safari:')
        print('    Pestaña PORTS (abajo) → puerto 6080 → icono del globo.')
        print('    Pulsa "Connect" y usa la contraseña:  fiesta')
        print('\n🔑 En ese escritorio verás el login de Ford. Entra con tu cuenta secundaria.')
        print('    Si pide un código por correo, escríbelo allí también.')
        print('\n⏳ Esperando a que termines el login (máximo 15 minutos)…\n')

        try:
            code = await asyncio.wait_for(captured, timeout=900)
        except asyncio.TimeoutError:
            raise SystemExit('❌ No he detectado el final del login en 15 minutos. Vuelve a ejecutar el programa.')
        finally:
            try:
                await browser.close()
            except Exception:
                pass
            proc.kill()
        return code


def main() -> None:
    print('━━━ Conectar tu coche con Ford ━━━\n')
    worker = (os.environ.get('FIESTA_URL') or input('URL de tu servidor (https://…workers.dev): ')).strip().rstrip('/')
    if not worker.startswith('https://'):
        raise SystemExit('❌ La URL tiene que empezar por https://')
    key = os.environ.get('FIESTA_KEY') or getpass.getpass('Contraseña de la app (APP_KEY, no se ve al escribir): ')

    verifier = b64url(secrets.token_bytes(48))
    challenge = b64url(hashlib.sha256(verifier.encode()).digest())
    params = {
        'redirect_uri': REDIRECT, 'response_type': 'code', 'scope': f'{CLIENT_ID} openid', 'max_age': '3600',
        'code_challenge': challenge, 'code_challenge_method': 'S256', 'client_id': CLIENT_ID,
        'language_code': LOCALE, 'ford_application_id': APP_ID_EU, 'country_code': COUNTRY,
    }
    auth_url = f'{LOGIN}/{TENANT}/{POLICY}/oauth2/v2.0/authorize?' + urllib.parse.urlencode(params, quote_via=urllib.parse.quote)

    saved = None
    if os.path.exists(TOKENS_FILE) and '--nuevo' not in sys.argv:
        try:
            saved = json.load(open(TOKENS_FILE))
            print(f'♻️  Uso el acceso de Ford que ya conseguiste (coche …{saved["vin"][-6:]}). No hace falta volver a hacer login.')
        except Exception:
            saved = None
    if saved:
        send(worker, key, saved)
        return

    if '--manual' in sys.argv:
        print('\nAbre esta dirección, haz login y pega aquí la dirección fordapp://… final:\n')
        print(auth_url, '\n')
        code = extract_code(input('Dirección final: ').strip())
        if not code:
            raise SystemExit('❌ Esa dirección no contiene el código.')
    else:
        code = asyncio.run(capture_code(auth_url))
    print('✅ Código de Ford capturado. Obteniendo acceso…')

    b2c = http('POST', f'{LOGIN}/{TENANT}/{POLICY}/oauth2/v2.0/token',
               headers={'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA},
               body=urllib.parse.urlencode({
                   'grant_type': 'authorization_code', 'code': code, 'redirect_uri': REDIRECT,
                   'client_id': CLIENT_ID, 'code_verifier': verifier, 'scope': f'{CLIENT_ID} openid',
               }).encode())
    if not b2c.get('access_token'):
        raise SystemExit(f'❌ Ford no ha dado acceso: {json.dumps(b2c)[:300]}')

    cat = http('POST', f'{FOUNDATIONAL}/api/token/v2/cat-with-b2c-access-token',
               headers={'application-id': APP_ID_EU, 'content-type': 'application/json', 'user-agent': UA},
               body=json.dumps({'idpToken': b2c['access_token']}).encode())
    if not cat.get('refresh_token'):
        raise SystemExit(f'❌ Ford no ha devuelto el token del coche: {json.dumps(cat)[:300]}')
    print('✅ Acceso de Ford conseguido. Buscando tu coche…')

    garage = http('GET', f'{VEHICLE}/api/fpcpl-user-garage-service/v1/user/garage', headers={
        'auth-token': cat['access_token'], 'application-id': APP_ID_EU, 'country-code': COUNTRY,
        'locale': LOCALE, 'user-agent': UA})
    vins = find_vins(garage)
    if not vins:
        raise SystemExit('❌ La cuenta no tiene ningún coche. Revisa que aceptaste la invitación en la app de Ford.')
    vin = vins[0]
    if len(vins) > 1:
        print('Hay varios coches:')
        for i, v in enumerate(vins, 1):
            print(f'  {i}. …{v[-6:]}')
        vin = vins[int(input('Número de tu coche: ') or 1) - 1]
    print(f'✅ Coche encontrado (VIN …{vin[-6:]}). Enviando a tu servidor…')
    tokens = {'cat': cat['access_token'], 'cat_refresh': cat['refresh_token'], 'vin': vin}
    with open(TOKENS_FILE, 'w') as fh:
        json.dump(tokens, fh)
    os.chmod(TOKENS_FILE, 0o600)
    send(worker, key, tokens)


def send(worker: str, key: str, tokens: dict) -> None:
    res = http('POST', f'{worker}/api/ford/connect',
               headers={'x-app-key': key, 'content-type': 'application/json', 'user-agent': BROWSER_UA, 'accept': 'application/json'},
               body=json.dumps(tokens).encode())
    if not res.get('ok'):
        raise SystemExit(f'⚠️  Tokens guardados, pero la primera lectura del coche ha fallado:\n{res.get("error")}\n\nCópiame este mensaje en el chat.')
    s = res.get('summary', {})
    print('\n🎉 ¡Conectado! Primera lectura de tu coche:')
    for k, label in [('fuel_pct', 'Combustible (%)'), ('range_km', 'Autonomía (km)'), ('odometer_km', 'Odómetro (km)'),
                     ('battery_v', 'Batería (V)'), ('ignition', 'Motor'), ('fields', 'Datos recibidos')]:
        print(f'   {label}: {s.get(k)}')
    print('\nYa puedes cerrar esto y abrir la app. Los datos de prueba se borran solos.')
    print('Cuando termines, borra el Codespace en github.com/codespaces para no gastar horas.')


if __name__ == '__main__':
    main()
