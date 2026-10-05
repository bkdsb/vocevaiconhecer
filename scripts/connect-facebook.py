#!/usr/bin/env python3
"""Connect a dedicated local browser profile through manual Facebook login.

Never imports another browser's cookies or prints authentication values.
"""
import json
import os
from pathlib import Path
import tempfile
import time
from datetime import datetime, timezone


def session_status(path, connected, state):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    record = {'connected': bool(connected), 'state': state,
              'updatedAt': datetime.now(timezone.utc).isoformat()}
    descriptor, temporary = tempfile.mkstemp(prefix='.facebook-session-', dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as handle:
            json.dump(record, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print(json.dumps(record), flush=True)


def main():
    profile = Path(os.environ.get('SCRAPLING_FACEBOOK_PROFILE', './data/facebook-browser')).resolve()
    status = profile.parent / 'facebook-session-status.json'
    profile.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(profile, 0o700)
    session_status(status, False, 'waiting_for_login')
    # Same Chromium engine/profile format as Scrapling's StealthyFetcher.
    from patchright.sync_api import sync_playwright
    try:
        with sync_playwright() as browser:
            context = browser.chromium.launch_persistent_context(
                str(profile), headless=False, locale='pt-BR',
                timezone_id='America/Sao_Paulo', no_viewport=True)
            try:
                page = context.pages[0] if context.pages else context.new_page()
                page.goto('https://www.facebook.com/', wait_until='domcontentloaded', timeout=60000)
                deadline = time.monotonic() + 600
                while time.monotonic() < deadline:
                    if not context.pages:
                        session_status(status, False, 'window_closed')
                        return 1
                    cookies = context.cookies('https://www.facebook.com/')
                    connected = any(cookie.get('name') == 'c_user'
                                    and (cookie.get('expires', -1) == -1 or cookie.get('expires', 0) > time.time())
                                    for cookie in cookies)
                    if connected:
                        session_status(status, True, 'connected')
                        return 0
                    # Yields to Playwright and checks only the owned context.
                    context.pages[0].wait_for_timeout(1000)
                session_status(status, False, 'login_timeout')
                return 1
            finally:
                context.close()
    except KeyboardInterrupt:
        session_status(status, False, 'interrupted')
        return 130
    except Exception:
        # Browser exceptions can include page state. Expose only a fixed code.
        session_status(status, False, 'browser_unavailable')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
