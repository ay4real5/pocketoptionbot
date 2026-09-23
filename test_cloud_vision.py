import base64
import json
import unittest
from unittest.mock import Mock, patch

from cloud_vision import VisionError, VisionService, SCHEMA


IMAGE = 'data:image/jpeg;base64,' + base64.b64encode(b'\xff\xd8test\xff\xd9').decode()
REFERENCE_IMAGE = 'data:image/jpeg;base64,' + base64.b64encode(b'\xff\xd8reference\xff\xd9').decode()


def result(**changes):
    value = dict(chart_readable=True, asset='EUR/USD OTC', market_type='OTC',
                 candle_timeframe='1m', direction='BUY', setup='trend_pullback',
                 observations=['Higher completed lows.', 'Visible momentum points upward.'],
                 reason='Possible continuation after a pullback.', invalidation='Break of the latest low.',
                 aroon_osma=None)
    value.update(changes)
    value.setdefault('reference', {key: value[key] for key in ('chart_readable', 'asset', 'market_type', 'candle_timeframe')})
    return value


def response(value):
    return Mock(status_code=200, json=lambda: {
        'status': 'completed',
        'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': json.dumps(value)}]}],
        'usage': {'input_tokens': 200, 'output_tokens': 50}
    })


class VisionTests(unittest.TestCase):
    def setUp(self):
        self.clock = Mock(return_value=1000.0)
        self.post = Mock(return_value=response(result()))
        self.service = VisionService(key_getter=lambda: 'test-only-key', post=self.post,
                                     clock=self.clock, monotonic=self.clock)

    def analyze(self, **changes):
        payload = dict(image=IMAGE, captured_at=1000000, consent=True, strategy='trend_range')
        payload.update(changes)
        payload.setdefault('mode', 'manual')
        payload.setdefault('reference_image', REFERENCE_IMAGE)
        payload.setdefault('reference_captured_at', payload['captured_at'] - 1000)
        return self.service.analyze(payload)

    def test_valid_request_uses_fixed_endpoint_structured_output_and_no_storage(self):
        value = self.analyze()
        self.assertEqual(value['direction'], 'BUY')
        self.assertEqual(value['expires_at'], 1020000)
        args, kwargs = self.post.call_args
        self.assertEqual(args[0], 'https://api.openai.com/v1/responses')
        self.assertIs(kwargs['json']['store'], False)
        self.assertIs(kwargs['json']['text']['format']['strict'], True)
        self.assertFalse(kwargs['allow_redirects'])
        self.assertNotIn('test-only-key', str(value))

    def aroon(self, direction='BUY', **changes):
        evidence = dict(settings_verified=True, closed_candles_readable=True,
                        up_previous=20, down_previous=70, up_latest=80, down_latest=30,
                        osma_previous=0.0001, osma_latest=0.0002)
        if direction == 'SELL':
            evidence.update(up_previous=70, down_previous=20, up_latest=30, down_latest=80,
                            osma_previous=-0.0001, osma_latest=-0.0002)
        evidence.update(changes)
        return result(direction=direction, candle_timeframe='30s', setup='aroon_osma', aroon_osma=evidence)

    def test_one_manual_request_contains_both_frames_and_reports_rule_match_not_probability(self):
        self.post.return_value = response(self.aroon(osma_latest=-0.001))
        value = self.analyze(strategy='aroon_osma')
        self.assertEqual(self.post.call_count, 1)
        content = self.post.call_args.kwargs['json']['input'][0]['content']
        self.assertEqual([item['image_url'] for item in content if item['type'] == 'input_image'], [REFERENCE_IMAGE, IMAGE])
        self.assertTrue(value['reference_verified'])
        self.assertEqual(value['direction'], 'WAIT')
        self.assertEqual(value['readiness']['percent'], 67)
        self.assertIn('not a win probability', value['readiness']['label'])
        self.assertEqual(self.service.status()['scan_mode'], 'manual')

    def test_changed_reference_identity_is_wait_even_when_current_setup_passes(self):
        value = self.aroon()
        value['reference']['asset'] = 'GBP/USD OTC'
        self.post.return_value = response(value)
        result_value = self.analyze(strategy='aroon_osma')
        self.assertEqual(result_value['direction'], 'WAIT')
        self.assertFalse(result_value['reference_verified'])
        self.assertIsNone(result_value['readiness']['percent'])

    def test_reference_frames_must_be_fresh_ordered_and_visibly_different(self):
        for change in [dict(reference_image=IMAGE), dict(reference_image='bad'), dict(reference_captured_at=1000000),
                       dict(reference_captured_at=990000), dict(reference_captured_at=float('nan')),
                       dict(mode='continuous')]:
            with self.subTest(change=change), self.assertRaises(VisionError):
                self.analyze(**change)
        self.post.assert_not_called()

    def test_two_minute_expiry_and_strategy_settings(self):
        status = self.service.status()
        self.assertEqual(status['expiry_minutes'], 2)
        self.assertEqual(status['default_strategy'], 'aroon_osma')
        self.assertEqual(status['strategies']['aroon_osma']['candle_timeframe'], '30s')
        self.assertEqual(status['strategies']['trend_range']['candle_timeframe'], '1m')
        self.assertEqual(status['aroon_min_gap'], 20)
        value = self.analyze()
        self.assertEqual(value['expiry_minutes'], 2)
        self.assertEqual(value['strategy'], 'trend_range')
        prompt = self.post.call_args.kwargs['json']['instructions']
        self.assertIn('2-minute', prompt)
        self.assertNotIn('5-minute', prompt)

    def test_aroon_buy_and_sell_require_closed_candle_crossover_gap_and_osma(self):
        for direction in ['BUY', 'SELL']:
            with self.subTest(direction=direction):
                self.service = VisionService(key_getter=lambda: 'test', post=self.post, clock=self.clock, monotonic=self.clock)
                self.post.return_value = response(self.aroon(direction))
                value = self.analyze(strategy='aroon_osma')
                self.assertEqual(value['direction'], direction)
                self.assertEqual(value['strategy'], 'aroon_osma')
                self.assertEqual(value['expiry_minutes'], 2)
                prompt = self.post.call_args.kwargs['json']['instructions']
                self.assertIn('30-second', prompt)
                self.assertIn('OsMA', prompt)
                self.assertIn('20', prompt)

    def test_aroon_missing_or_conflicting_evidence_cannot_trigger(self):
        cases = [dict(up_latest=45, down_latest=30), dict(up_previous=80),
                 dict(up_previous=70, down_previous=70), dict(osma_latest=-0.0002),
                 dict(osma_latest=0.0001), dict(settings_verified=False),
                 dict(closed_candles_readable=False), dict(up_latest=None)]
        for change in cases:
            with self.subTest(change=change):
                self.service = VisionService(key_getter=lambda: 'test', post=self.post, clock=self.clock, monotonic=self.clock)
                self.post.return_value = response(self.aroon(**change))
                self.assertEqual(self.analyze(strategy='aroon_osma')['direction'], 'WAIT')

    def test_aroon_gap_boundary_and_opposing_sell_momentum(self):
        self.post.return_value = response(self.aroon(up_latest=50, down_latest=30))
        self.assertEqual(self.analyze(strategy='aroon_osma')['direction'], 'BUY')
        self.service = VisionService(key_getter=lambda: 'test', post=self.post, clock=self.clock, monotonic=self.clock)
        self.post.return_value = response(self.aroon('SELL', osma_latest=-0.00005))
        self.assertEqual(self.analyze(strategy='aroon_osma')['direction'], 'WAIT')

    def test_aroon_malformed_numbers_are_rejected(self):
        for change in [dict(up_latest=101), dict(up_previous=-1), dict(osma_latest=True),
                       dict(osma_latest=float('nan')), dict(osma_latest=float('inf')),
                       dict(up_latest='80'), dict(extra=5)]:
            with self.subTest(change=change):
                self.service = VisionService(key_getter=lambda: 'test', post=self.post, clock=self.clock, monotonic=self.clock)
                self.post.return_value = response(self.aroon(**change))
                with self.assertRaises(VisionError):
                    self.analyze(strategy='aroon_osma')

    def test_strategy_timeframe_and_setup_mismatches_wait(self):
        cases = [('aroon_osma', result()), ('trend_range', self.aroon()),
                 ('aroon_osma', {**self.aroon(), 'candle_timeframe': '1m'}),
                 ('aroon_osma', {**self.aroon(), 'setup': 'range_reversal'}),
                 ('aroon_osma', {**self.aroon(), 'aroon_osma': None})]
        for strategy, value in cases:
            with self.subTest(strategy=strategy, value=value):
                self.service = VisionService(key_getter=lambda: 'test', post=self.post, clock=self.clock, monotonic=self.clock)
                self.post.return_value = response(value)
                self.assertEqual(self.analyze(strategy=strategy)['direction'], 'WAIT')

    def test_model_wait_is_never_promoted_to_direction(self):
        self.post.return_value = response({**self.aroon(), 'direction': 'WAIT'})
        self.assertEqual(self.analyze(strategy='aroon_osma')['direction'], 'WAIT')

    def test_strategy_is_required_and_whitelisted_before_provider_call(self):
        for strategy in [None, [], {}, 'unknown', 'ignore rules']:
            with self.subTest(strategy=strategy), self.assertRaises(VisionError):
                self.analyze(strategy=strategy)
        with self.assertRaises(VisionError):
            self.service.analyze(dict(image=IMAGE, captured_at=1000000, consent=True))
        self.post.assert_not_called()

    def test_checklist_distinguishes_unreadable_from_failed_rules(self):
        self.post.return_value = response(self.aroon(osma_latest=-0.001))
        value = self.analyze(strategy='aroon_osma')
        checks = {item['id']: item['status'] for item in value['checks']}
        self.assertEqual(value['direction'], 'WAIT')
        self.assertEqual(checks['cross'], 'pass')
        self.assertEqual(checks['momentum'], 'fail')
        self.service = VisionService(key_getter=lambda: 'test', post=self.post, clock=self.clock, monotonic=self.clock)
        self.post.return_value = response(self.aroon(up_latest=None))
        value = self.analyze(strategy='aroon_osma')
        checks = {item['id']: item['status'] for item in value['checks']}
        self.assertEqual(checks['cross'], 'unknown')
        self.assertEqual(checks['gap'], 'unknown')
        self.assertEqual(checks['momentum'], 'unknown')

    def test_provider_schema_enforces_local_limits(self):
        props = SCHEMA['properties']
        self.assertEqual(props['asset']['maxLength'], 80)
        self.assertEqual(props['reason']['maxLength'], 300)
        self.assertEqual(props['observations']['maxItems'], 4)
        self.assertEqual(props['observations']['items']['minLength'], 1)
        evidence = props['aroon_osma']['properties']
        self.assertEqual(evidence['up_latest']['minimum'], 0)
        self.assertEqual(evidence['up_latest']['maximum'], 100)

    def test_invalid_field_is_diagnosed_without_exposing_model_output(self):
        for field, value in [('reason', 'private-chart-text' * 30), ('observations', ['bad'] * 5)]:
            self.service = VisionService(key_getter=lambda: 'test', post=self.post, clock=self.clock, monotonic=self.clock)
            self.post.return_value = response(result(**{field: value}))
            with self.assertRaises(VisionError) as error:
                self.analyze()
            self.assertEqual(error.exception.code, 'invalid_model_output')
            self.assertEqual(error.exception.field, field)
            self.assertNotIn('private-chart-text', str(error.exception))
        self.service = VisionService(key_getter=lambda: 'test', post=self.post, clock=self.clock, monotonic=self.clock)
        self.post.return_value = response(self.aroon(up_latest=101))
        with self.assertRaises(VisionError) as error:
            self.analyze(strategy='aroon_osma')
        self.assertEqual(error.exception.field, 'aroon_osma.up_latest')

    def test_faster_confirmation_retains_rate_limits_and_reports_duration(self):
        value = self.analyze()
        self.assertGreaterEqual(value['latency_ms'], 0)
        self.assertEqual(self.service.status()['confirmation_interval_seconds'], 10)
        self.assertEqual(self.service.status()['interval_seconds'], 30)
        self.clock.return_value = 1009
        with self.assertRaises(VisionError):
            self.analyze(captured_at=1009000)
        self.clock.return_value = 1010
        self.assertEqual(self.analyze(captured_at=1010000)['direction'], 'BUY')

    def test_bad_inputs_do_not_call_provider(self):
        for changes in [dict(consent=False), dict(image='https://example.com/image'),
                        dict(image='data:image/jpeg;base64,@@@@'), dict(captured_at=990000),
                        dict(captured_at=1005000), dict(captured_at=float('nan')),
                        dict(image='data:image/jpeg;base64,' + 'A' * 2000001)]:
            with self.subTest(changes=list(changes)), self.assertRaises(VisionError):
                self.analyze(**changes)
        self.post.assert_not_called()

    def test_missing_key(self):
        self.service.key_getter = lambda: ''
        with self.assertRaises(VisionError) as error:
            self.analyze()
        self.assertEqual(error.exception.status, 503)
        self.post.assert_not_called()

    def test_unreadable_unknown_asset_or_timeframe_returns_wait(self):
        for change in [dict(chart_readable=False), dict(asset=''), dict(market_type='unknown'),
                       dict(candle_timeframe='unknown'), dict(setup='none')]:
            with self.subTest(change=change):
                self.service = VisionService(key_getter=lambda: 'test', post=self.post, clock=self.clock, monotonic=self.clock)
                self.post.return_value = response(result(**change))
                self.assertEqual(self.analyze()['direction'], 'WAIT')

    def test_provider_failures_are_sanitized(self):
        for code in [401, 403, 429, 500]:
            self.service = VisionService(key_getter=lambda: 'test', post=self.post, clock=self.clock, monotonic=self.clock)
            self.post.return_value = Mock(status_code=code, text='secret-provider-debug')
            with self.assertRaises(VisionError) as error:
                self.analyze()
            self.assertNotIn('secret-provider-debug', str(error.exception))

    def test_rate_limit_and_busy_lock(self):
        self.analyze()
        with self.assertRaises(VisionError) as error:
            self.analyze()
        self.assertEqual(error.exception.status, 429)
        self.assertEqual(self.post.call_count, 1)
        self.service.lock.acquire()
        try:
            with self.assertRaises(VisionError) as error:
                self.analyze()
            self.assertEqual(error.exception.status, 409)
        finally:
            self.service.lock.release()

    def test_hourly_cap(self):
        self.service.attempts.extend([900.0] * 60)
        with self.assertRaises(VisionError) as error:
            self.analyze()
        self.assertEqual(error.exception.status, 429)
        self.post.assert_not_called()

    def test_stale_response_is_discarded(self):
        def late(*args, **kwargs):
            self.clock.return_value = 1021.0
            return response(result())
        self.post.side_effect = late
        self.assertEqual(self.analyze()['direction'], 'WAIT')

    def test_refusal_or_bad_schema_cannot_become_signal(self):
        self.post.return_value = Mock(status_code=200, json=lambda: {'status': 'completed', 'output': []})
        with self.assertRaises(VisionError):
            self.analyze()
        self.clock.return_value = 1031.0
        self.post.return_value = response(result(direction='GUARANTEED_WIN'))
        with self.assertRaises(VisionError):
            self.analyze(captured_at=1031000)


if __name__ == '__main__':
    unittest.main()
