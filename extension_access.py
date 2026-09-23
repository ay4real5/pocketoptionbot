import hashlib
import json
import math
import os
import re
import secrets
import tempfile
import threading
import time
from pathlib import Path

from flask import jsonify, render_template, request
from werkzeug.exceptions import BadRequest, RequestEntityTooLarge


REMEMBER_SECONDS = 30 * 86400


class ExtensionAccess:
    def __init__(self, clock=time.time, state_path=None):
        self.clock = clock
        self.state_path = Path(state_path) if state_path else None
        self.lock = threading.Lock()
        self.pending = None
        self.session = None
        if self.state_path:
            try:
                if self.state_path.stat().st_size > 2048:
                    return
                item = json.loads(self.state_path.read_text(encoding='utf-8'))
                if (isinstance(item, dict) and self.valid_origin(item.get('origin')) and
                        isinstance(item.get('digest'), str) and re.fullmatch('[0-9a-f]{64}', item['digest']) and
                        type(item.get('expires')) in (int, float) and math.isfinite(item['expires']) and
                        self.clock() < item['expires'] <= self.clock() + REMEMBER_SECONDS):
                    self.session = item
            except (OSError, ValueError, TypeError):
                pass

    @staticmethod
    def same(left, right):
        return isinstance(left, str) and len(left) <= 256 and secrets.compare_digest(left.encode(), right.encode())

    @staticmethod
    def valid_origin(origin):
        return isinstance(origin, str) and re.fullmatch(r'chrome-extension://[a-p]{32}', origin) is not None

    @staticmethod
    def origin(extension_id):
        if not isinstance(extension_id, str) or not re.fullmatch('[a-p]{32}', extension_id):
            raise ValueError('Invalid extension ID.')
        return f'chrome-extension://{extension_id}'

    @staticmethod
    def digest(value):
        return hashlib.sha256(value.encode()).hexdigest()

    def save(self, item):
        if not self.state_path:
            return
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=self.state_path.parent, delete=False) as output:
                temporary = Path(output.name)
                json.dump(item, output)
            os.replace(temporary, self.state_path)
        finally:
            if temporary and temporary.exists():
                temporary.unlink()

    def grant(self, origin, lifetime):
        token = secrets.token_urlsafe(32)
        session = dict(origin=origin, digest=self.digest(token), expires=self.clock() + lifetime)
        self.save(session)
        self.session = session
        self.pending = None
        return token

    def issue(self, extension_id):
        origin = self.origin(extension_id)
        with self.lock:
            code = secrets.token_urlsafe(24)
            self.pending = dict(origin=origin, code=code, expires=self.clock() + 120, attempts=0)
            return code

    def approve(self, extension_id, request_hash):
        origin = self.origin(extension_id)
        if not isinstance(request_hash, str) or not re.fullmatch('[0-9a-f]{64}', request_hash):
            raise ValueError('Invalid approval request.')
        with self.lock:
            self.pending = dict(origin=origin, request_hash=request_hash, expires=self.clock() + 120)

    def claim(self, origin, secret):
        if not isinstance(secret, str) or not re.fullmatch('[A-Za-z0-9_-]{32,128}', secret):
            return None
        with self.lock:
            item = self.pending
            if (not item or item['origin'] != origin or item['expires'] <= self.clock() or
                    not self.same(self.digest(secret), item.get('request_hash', ''))):
                return None
            return self.grant(origin, REMEMBER_SECONDS)

    def allowed(self, origin):
        with self.lock:
            return any(item and item['origin'] == origin and item['expires'] > self.clock()
                       for item in (self.pending, self.session))

    def redeem(self, origin, code):
        with self.lock:
            item = self.pending
            if not item or 'code' not in item or item['origin'] != origin or item['expires'] <= self.clock():
                return None
            item['attempts'] += 1
            if not self.same(code, item['code']):
                if item['attempts'] >= 5:
                    self.pending = None
                return None
            return self.grant(origin, 8 * 3600)

    def authorized(self, origin, token):
        if not isinstance(token, str) or len(token) > 256:
            return False
        with self.lock:
            return bool(self.session and self.session['origin'] == origin and
                        self.session['expires'] > self.clock() and self.same(self.digest(token), self.session['digest']))

    def revoke(self):
        with self.lock:
            self.save(None)
            self.pending = None
            self.session = None


def register_extension_routes(app, vision, page_token, is_local, analyze_capture, state_path=None, journal_handler=None):
    access = ExtensionAccess(state_path=state_path)

    def local_authorized():
        return (is_local() and request.headers.get('Origin') == request.host_url.rstrip('/') and
                access.same(request.headers.get('X-Vision-Token'), page_token))

    def extension_authorized():
        return is_local() and access.authorized(request.headers.get('Origin'), request.headers.get('X-Extension-Token'))

    @app.after_request
    def extension_headers(response):
        if request.path.startswith('/api/extension/') or request.path == '/extension-pair':
            response.headers['Cache-Control'] = 'no-store'
            origin = request.headers.get('Origin')
            if is_local() and (access.allowed(origin) or (request.path in ('/api/extension/claim', '/api/extension/status') and access.valid_origin(origin))):
                response.headers['Access-Control-Allow-Origin'] = origin
                response.headers['Vary'] = 'Origin'
                response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
                response.headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Extension-Token'
                if request.headers.get('Access-Control-Request-Private-Network') == 'true':
                    response.headers['Access-Control-Allow-Private-Network'] = 'true'
        return response

    @app.route('/extension-pair')
    def extension_pair_page():
        if not is_local():
            return jsonify(error='Local access required.'), 403
        response = app.make_response(render_template('extension_pair.html', vision_token=page_token,
                                                     extension_id=request.args.get('extension_id', ''),
                                                     request_hash=request.args.get('request', '')))
        response.headers['Content-Security-Policy'] = (
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
        response.headers['Referrer-Policy'] = 'no-referrer'
        return response

    @app.route('/api/extension/approve', methods=['POST'])
    def extension_approve():
        if not local_authorized():
            return jsonify(reason='Local page approval required.'), 403
        request.max_content_length = 2048
        try:
            payload = request.get_json(silent=True)
            if isinstance(payload, dict) and 'request_hash' in payload:
                access.approve(payload.get('extension_id'), payload['request_hash'])
                return jsonify(approved=True)
            code = access.issue(payload.get('extension_id') if isinstance(payload, dict) else None)
            return jsonify(code=code, expires_in=120)
        except (ValueError, BadRequest, RequestEntityTooLarge):
            return jsonify(reason='Open a fresh connection request from the extension.'), 400

    @app.route('/api/extension/claim', methods=['POST'])
    def extension_claim():
        if not is_local() or not access.valid_origin(request.headers.get('Origin')):
            return jsonify(reason='Extension request required.'), 403
        request.max_content_length = 2048
        try:
            payload = request.get_json(silent=True)
            token = access.claim(request.headers.get('Origin'), payload.get('secret') if isinstance(payload, dict) else None)
        except (BadRequest, RequestEntityTooLarge):
            return jsonify(reason='Invalid connection request.'), 400
        except OSError:
            return jsonify(reason='Cannot save the local approval. Check access to the project data folder.'), 503
        if not token:
            return jsonify(approved=False), 202
        return jsonify(access_token=token, expires_in=REMEMBER_SECONDS)

    @app.route('/api/extension/revoke', methods=['POST'])
    def extension_revoke():
        if not local_authorized() and not extension_authorized():
            return jsonify(reason='Authorization required.'), 403
        response = jsonify(revoked=True)
        if extension_authorized():
            response.headers['Access-Control-Allow-Origin'] = request.headers['Origin']
            response.headers['Vary'] = 'Origin'
        try:
            access.revoke()
        except OSError:
            return jsonify(reason='Could not save revocation. Check the project data folder permissions.'), 503
        return response

    @app.route('/api/extension/pair', methods=['POST'])
    def extension_pair():
        if not is_local() or not access.allowed(request.headers.get('Origin')):
            return jsonify(reason='Approve this extension on the local page first.'), 403
        request.max_content_length = 2048
        try:
            payload = request.get_json(silent=True)
            token = access.redeem(request.headers.get('Origin'), payload.get('code') if isinstance(payload, dict) else None)
        except (BadRequest, RequestEntityTooLarge, OSError):
            token = None
        if not token:
            return jsonify(reason='Pairing code invalid or expired. Update the extension to connect without codes.'), 403
        return jsonify(access_token=token, expires_in=8 * 3600)

    @app.route('/api/extension/status', methods=['GET', 'POST'])
    def extension_status():
        if not extension_authorized():
            return jsonify(reason='Connection approval required.', error_code='authorization'), 403
        return jsonify(vision.status())

    @app.route('/api/extension/analyze', methods=['POST'])
    def extension_analyze():
        if not extension_authorized():
            return jsonify(direction='WAIT', reason='Connection approval required.', error_code='authorization'), 403
        return analyze_capture()

    @app.route('/api/extension/journal/<action>', methods=['POST'])
    def extension_journal(action):
        if not extension_authorized():
            return jsonify(reason='Connection approval required.'), 403
        if journal_handler is None:
            return jsonify(reason='Journal unavailable.'), 503
        return journal_handler(action)

    return access
