import unittest
from unittest.mock import patch

import app as dashboard


class ScreenRoutesTest(unittest.TestCase):
    def setUp(self):
        self.client = dashboard.app.test_client()
        self.headers = {'Origin': 'http://localhost', 'X-Vision-Token': dashboard.vision_token}

    def test_separate_page_and_privacy_headers(self):
        response = self.client.get('/screen-analysis')
        self.assertEqual(response.status_code, 200)
        self.assertIn(b'Pocket Option AI Chart Assistant', response.data)
        self.assertIn(b'not a validated trading strategy', response.data)
        self.assertIn("connect-src 'self'", response.headers['Content-Security-Policy'])
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        self.assertIn(b'No image is uploaded until you approve', response.data)
        self.assertIn(b'id="captureHelp"', response.data)
        self.assertIn(b'Microsoft Edge Tab', response.data)
        self.assertIn(b'same Chrome or Edge browser profile', response.data)
        self.assertIn(b'id="strategy"', response.data)
        self.assertIn(b'id="moreToolbar"', response.data)
        self.assertIn(b'2m timer / result', response.data)
        self.assertNotIn(b'5m timer', response.data)
        self.assertNotIn(b'https://', response.data)

    def test_scripts_and_dashboard_link(self):
        for path in ['/static/screen_analysis.js', '/static/screen_capture.js']:
            response = self.client.get(path)
            self.assertEqual(response.status_code, 200)
            response.close()
        self.assertIn(b'href="/screen-analysis"', self.client.get('/').data)

    def test_setup_reports_boolean_not_key(self):
        with patch.object(dashboard.vision, 'key_getter', return_value='test-secret-do-not-expose'):
            response = self.client.get('/api/vision/status')
        self.assertTrue(response.json['configured'])
        self.assertEqual(response.json['expiry_minutes'], 2)
        self.assertEqual(response.json['strategies']['aroon_osma']['candle_timeframe'], '30s')
        self.assertEqual(self.client.get('/api/status').json['expiry_minutes'], 5)
        self.assertNotIn(b'test-secret-do-not-expose', response.data)

    def test_cross_origin_missing_token_and_dns_rebinding_are_blocked(self):
        with patch.object(dashboard.vision, 'analyze') as analyze:
            for headers in [{}, {'Origin': 'http://evil.example', 'X-Vision-Token': dashboard.vision_token},
                            {'Origin': 'http://localhost', 'X-Vision-Token': 'wrong'}]:
                response = self.client.post('/api/vision/analyze', json={}, headers=headers)
                self.assertEqual(response.status_code, 403)
            analyze.assert_not_called()
        for path in ['/screen-analysis', '/api/vision/status']:
            self.assertEqual(self.client.get(path, base_url='http://evil.example').status_code, 403)
            self.assertEqual(self.client.get(path, environ_base={'REMOTE_ADDR': '192.168.1.20'}).status_code, 403)

    def test_authorized_analysis_and_size_limit(self):
        with patch.object(dashboard.vision, 'analyze', return_value={'direction': 'WAIT'}) as analyze:
            response = self.client.post('/api/vision/analyze', json={'consent': True}, headers=self.headers)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers['Cache-Control'], 'no-store')
            analyze.assert_called_once_with({'consent': True})
        with patch.object(dashboard.vision, 'analyze') as analyze:
            response = self.client.post('/api/vision/analyze', json={'image': 'A' * 2100001}, headers=self.headers)
            self.assertEqual(response.status_code, 413)
            analyze.assert_not_called()

    def test_invalid_json_fails_closed(self):
        response = self.client.post('/api/vision/analyze', data='{', content_type='application/json', headers=self.headers)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json['direction'], 'WAIT')


if __name__ == '__main__':
    unittest.main()
