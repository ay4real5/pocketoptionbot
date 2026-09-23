import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import app as dashboard
from cloud_vision import VisionService
from extension_access import ExtensionAccess
from test_cloud_vision import IMAGE, REFERENCE_IMAGE, response, result


EXTENSION_ID = 'a' * 32
ORIGIN = 'chrome-extension://' + EXTENSION_ID


class ExtensionAccessTests(unittest.TestCase):
    def setUp(self):
        self.clock = Mock(return_value=1000)
        self.access = ExtensionAccess(self.clock)

    def test_codes_are_bound_single_use_and_tokens_are_origin_bound(self):
        code = self.access.issue(EXTENSION_ID)
        self.assertIsNone(self.access.redeem('chrome-extension://' + 'b' * 32, code))
        token = self.access.redeem(ORIGIN, code)
        self.assertTrue(token)
        self.assertTrue(self.access.authorized(ORIGIN, token))
        self.assertFalse(self.access.authorized('https://evil.example', token))
        self.assertFalse(self.access.authorized(ORIGIN, 'incorrect'))
        self.assertIsNone(self.access.redeem(ORIGIN, code))

    def test_expiry_revoke_and_attempt_limit(self):
        code = self.access.issue(EXTENSION_ID)
        self.clock.return_value = 1120
        self.assertIsNone(self.access.redeem(ORIGIN, code))
        code = self.access.issue(EXTENSION_ID)
        for _ in range(5):
            self.assertIsNone(self.access.redeem(ORIGIN, 'bad'))
        self.assertIsNone(self.access.redeem(ORIGIN, code))
        code = self.access.issue(EXTENSION_ID)
        token = self.access.redeem(ORIGIN, code)
        self.clock.return_value += 28800
        self.assertFalse(self.access.authorized(ORIGIN, token))
        token = self.access.redeem(ORIGIN, self.access.issue(EXTENSION_ID))
        self.access.revoke()
        self.assertFalse(self.access.authorized(ORIGIN, token))
        self.assertFalse(self.access.allowed(ORIGIN))

    def test_one_click_approval_requires_private_challenge_and_survives_restart(self):
        secret = 's' * 64
        digest = hashlib.sha256(secret.encode()).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'extension-access.json'
            access = ExtensionAccess(self.clock, state_path=path)
            self.assertIsNone(access.claim(ORIGIN, secret))
            access.approve(EXTENSION_ID, digest)
            self.assertIsNone(access.claim('chrome-extension://' + 'b' * 32, secret))
            self.assertIsNone(access.claim(ORIGIN, digest))
            token = access.claim(ORIGIN, secret)
            self.assertTrue(token)
            self.assertNotIn(token, path.read_text())
            self.assertNotIn(secret, path.read_text())
            restarted = ExtensionAccess(self.clock, state_path=path)
            self.assertTrue(restarted.authorized(ORIGIN, token))
            self.assertIsNone(restarted.claim(ORIGIN, secret))
            restarted.revoke()
            self.assertFalse(ExtensionAccess(self.clock, state_path=path).authorized(ORIGIN, token))

    def test_remembered_connection_expires_and_corrupt_file_fails_closed(self):
        secret = 'x' * 64
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'extension-access.json'
            access = ExtensionAccess(self.clock, state_path=path)
            access.approve(EXTENSION_ID, hashlib.sha256(secret.encode()).hexdigest())
            token = access.claim(ORIGIN, secret)
            self.clock.return_value += 30 * 86400
            self.assertFalse(ExtensionAccess(self.clock, state_path=path).authorized(ORIGIN, token))
            path.write_text('{broken')
            self.assertFalse(ExtensionAccess(self.clock, state_path=path).authorized(ORIGIN, token))

    def test_ids_and_non_string_or_unicode_credentials_are_safe(self):
        for value in [None, {}, 'a' * 31, 'z' * 32, 'https://evil.example']:
            with self.assertRaises(ValueError):
                self.access.issue(value)
        code = self.access.issue(EXTENSION_ID)
        self.assertIsNone(self.access.redeem(ORIGIN, ['bad']))
        self.assertIsNone(self.access.redeem(ORIGIN, '\u0100'))
        self.assertTrue(self.access.redeem(ORIGIN, code))


class ExtensionRoutesTests(unittest.TestCase):
    def setUp(self):
        self.client = dashboard.app.test_client()
        dashboard.extension_access.revoke()
        self.local = {'Origin': 'http://localhost', 'X-Vision-Token': dashboard.vision_token}

    def pair(self):
        approved = self.client.post('/api/extension/approve', headers=self.local, json={'extension_id': EXTENSION_ID})
        self.assertEqual(approved.status_code, 200)
        paired = self.client.post('/api/extension/pair', headers={'Origin': ORIGIN}, json={'code': approved.json['code']})
        self.assertEqual(paired.status_code, 200)
        self.assertEqual(paired.headers['Access-Control-Allow-Origin'], ORIGIN)
        self.assertEqual(paired.headers['Cache-Control'], 'no-store')
        return {'Origin': ORIGIN, 'X-Extension-Token': paired.json['access_token']}

    def test_local_approval_requires_local_origin_and_page_token(self):
        for headers in [{}, {'Origin': ORIGIN, 'X-Vision-Token': dashboard.vision_token},
                        {'Origin': 'https://evil.example', 'X-Vision-Token': dashboard.vision_token}]:
            self.assertEqual(self.client.post('/api/extension/approve', headers=headers,
                                             json={'extension_id': EXTENSION_ID}).status_code, 403)
        self.assertEqual(self.client.get('/extension-pair', environ_base={'REMOTE_ADDR': '192.168.1.10'}).status_code, 403)
        self.assertEqual(self.client.get('/extension-pair', base_url='http://evil.example').status_code, 403)
        page = self.client.get('/extension-pair')
        self.assertIn("frame-ancestors 'none'", page.headers['Content-Security-Policy'])
        self.assertEqual(page.headers['Cache-Control'], 'no-store')

    def test_only_approved_origin_receives_cors(self):
        self.client.post('/api/extension/approve', headers=self.local, json={'extension_id': EXTENSION_ID})
        for origin in ['https://evil.example', 'null', 'chrome-extension://' + 'b' * 32]:
            response = self.client.options('/api/extension/analyze', headers={'Origin': origin, 'Access-Control-Request-Method': 'POST'})
            self.assertNotIn('Access-Control-Allow-Origin', response.headers)
        response = self.client.options('/api/extension/analyze', headers={'Origin': ORIGIN, 'Access-Control-Request-Method': 'POST'})
        self.assertEqual(response.headers['Access-Control-Allow-Origin'], ORIGIN)
        self.assertNotIn('Access-Control-Allow-Credentials', response.headers)

    def test_unapproved_extension_can_read_denial_but_cannot_read_settings_or_analyze(self):
        rejected = self.client.post('/api/extension/status', headers={'Origin': ORIGIN}, json={})
        self.assertEqual(rejected.status_code, 403)
        self.assertEqual(rejected.headers['Access-Control-Allow-Origin'], ORIGIN)
        self.assertNotIn('configured', rejected.json)
        self.assertEqual(rejected.json['error_code'], 'authorization')
        self.assertEqual(self.client.post('/api/extension/analyze', headers={'Origin': ORIGIN}, json={}).status_code, 403)
        foreign = self.client.post('/api/extension/status', headers={'Origin': 'https://evil.example'}, json={})
        self.assertNotIn('Access-Control-Allow-Origin', foreign.headers)

    def test_code_free_handoff_requires_explicit_approval_and_exact_origin(self):
        secret = 'p' * 64
        request_hash = hashlib.sha256(secret.encode()).hexdigest()
        self.assertEqual(self.client.post('/api/extension/claim', headers={'Origin': ORIGIN}, json={'secret': secret}).status_code, 202)
        page = self.client.get('/extension-pair', query_string={'extension_id': EXTENSION_ID, 'request': request_hash})
        self.assertIn(b'Approve connection', page.data)
        self.assertNotIn(b'Copy pairing code', page.data)
        self.assertNotIn(secret.encode(), page.data)
        self.assertEqual(self.client.post('/api/extension/claim', headers={'Origin': ORIGIN}, json={'secret': secret}).status_code, 202)
        approved = self.client.post('/api/extension/approve', headers=self.local,
                                    json={'extension_id': EXTENSION_ID, 'request_hash': request_hash})
        self.assertEqual(approved.status_code, 200)
        self.assertNotIn('code', approved.json)
        other = self.client.post('/api/extension/claim', headers={'Origin': 'https://evil.example'}, json={'secret': secret})
        self.assertEqual(other.status_code, 403)
        self.assertNotIn('Access-Control-Allow-Origin', other.headers)
        paired = self.client.post('/api/extension/claim', headers={'Origin': ORIGIN}, json={'secret': secret})
        self.assertEqual(paired.status_code, 200)
        self.assertEqual(paired.json['expires_in'], 30 * 86400)
        headers = {'Origin': ORIGIN, 'X-Extension-Token': paired.json['access_token']}
        self.assertEqual(self.client.post('/api/extension/status', headers=headers, json={}).status_code, 200)
        self.assertEqual(self.client.post('/api/extension/claim', headers={'Origin': ORIGIN}, json={'secret': secret}).status_code, 202)

    def test_paired_analysis_still_checks_payload_and_shares_service(self):
        headers = self.pair()
        service = VisionService(key_getter=lambda: 'test', post=Mock(return_value=response(result())),
                                clock=lambda: 1000, monotonic=lambda: 1000)
        with patch.object(dashboard.vision, 'analyze', side_effect=service.analyze):
            payload = dict(image=IMAGE, reference_image=REFERENCE_IMAGE, reference_captured_at=999000, mode='manual', captured_at=1000000, consent=False, strategy='trend_range')
            denied = self.client.post('/api/extension/analyze', headers=headers, json=payload)
            self.assertEqual(denied.status_code, 400)
            service.post.assert_not_called()
            payload['consent'] = True
            accepted = self.client.post('/api/extension/analyze', headers=headers, json=payload)
            self.assertEqual(accepted.status_code, 200)
            self.assertEqual(accepted.json['expiry_minutes'], 2)
            self.assertEqual(accepted.json['direction'], 'BUY')
            self.assertEqual(accepted.headers['Cache-Control'], 'no-store')
            limited = self.client.post('/api/extension/analyze', headers=headers, json=payload)
            self.assertEqual(limited.status_code, 429)
            self.assertEqual(service.post.call_count, 1)

    def test_unpaired_or_wrong_origin_token_cannot_analyze(self):
        headers = self.pair()
        with patch.object(dashboard.vision, 'analyze') as analyze:
            for bad in [{}, {**headers, 'Origin': 'https://evil.example'}, {**headers, 'X-Extension-Token': 'wrong'}]:
                self.assertEqual(self.client.post('/api/extension/analyze', headers=bad, json={}).status_code, 403)
            self.assertEqual(self.client.post('/api/extension/analyze', headers=headers, json={},
                                             environ_base={'REMOTE_ADDR': '10.0.0.1'}).status_code, 403)
            self.assertEqual(self.client.post('/api/vision/analyze', headers=headers, json={}).status_code, 403)
            analyze.assert_not_called()

    def test_revoke_and_restart_invalidate_access(self):
        headers = self.pair()
        self.assertEqual(self.client.get('/api/extension/status', headers=headers).status_code, 200)
        revoked = self.client.post('/api/extension/revoke', headers=headers)
        self.assertEqual(revoked.status_code, 200)
        self.assertEqual(revoked.headers['Access-Control-Allow-Origin'], ORIGIN)
        self.assertEqual(self.client.get('/api/extension/status', headers=headers).status_code, 403)
        self.assertFalse(ExtensionAccess().authorized(ORIGIN, headers['X-Extension-Token']))

    def test_journal_routes_require_authorization_and_persist_manual_outcomes(self):
        from vision_journal import VisionJournal
        from test_vision_journal import assessment
        clock = Mock(return_value=1000)
        journal = VisionJournal(clock=clock)
        headers = self.pair()
        try:
            with patch.object(dashboard, 'vision_journal', journal):
                self.assertEqual(self.client.post('/api/extension/journal/query', json={}).status_code, 403)
                self.assertEqual(self.client.post('/api/vision/journal/query', json={}).status_code, 403)
                identifier = journal.record(assessment())
                shown = self.client.post('/api/extension/journal/present', headers=headers, json={'analysis_id': identifier})
                self.assertEqual(shown.status_code, 200)
                opened = self.client.post('/api/extension/journal/entry', headers=headers,
                                          json={'analysis_id': identifier, 'stake': '10', 'payout_percent': '92'})
                self.assertEqual(opened.status_code, 200)
                clock.return_value = 1120
                closed = self.client.post('/api/extension/journal/outcome', headers=headers,
                                          json={'entry_id': opened.json['id'], 'result': 'win'})
                self.assertEqual(closed.status_code, 200)
                query = self.client.post('/api/extension/journal/query', headers=headers, json={})
                self.assertEqual(query.headers['Cache-Control'], 'no-store')
                self.assertEqual(query.json['summary']['net_units'], 9.2)
                self.assertEqual(query.json['summary']['displayed_signals'], 1)
                self.assertEqual(query.json['groups'][0]['market_type'], 'OTC')
        finally:
            journal.close()

    def test_validation_diagnostic_is_sanitized_and_images_are_size_limited(self):
        headers = self.pair()
        service = VisionService(key_getter=lambda: 'test', post=Mock(return_value=response(result(reason='private' * 60))),
                                clock=lambda: 1000, monotonic=lambda: 1000)
        with patch.object(dashboard.vision, 'analyze', side_effect=service.analyze):
            rejected = self.client.post('/api/extension/analyze', headers=headers,
                                       json=dict(image=IMAGE, reference_image=REFERENCE_IMAGE, reference_captured_at=999000, mode='manual', captured_at=1000000, consent=True, strategy='trend_range'))
        self.assertEqual(rejected.status_code, 502)
        self.assertEqual(rejected.json['invalid_field'], 'reason')
        self.assertNotIn(b'private', rejected.data)
        oversized = self.client.post('/api/extension/analyze', headers=headers, json={'image': 'A' * 2100001})
        self.assertEqual(oversized.status_code, 413)


if __name__ == '__main__':
    unittest.main()
