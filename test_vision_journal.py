import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from vision_journal import VisionJournal, JournalError


def assessment(direction='BUY'):
    return dict(captured_at=1000000, expires_at=1020000, asset='EUR/USD OTC', market_type='OTC', strategy='aroon_osma',
                candle_timeframe='30s', direction=direction, expiry_minutes=2, latency_ms=2500, reason='Test only', checks=[])


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.clock = Mock(return_value=1000)
        self.journal = VisionJournal(clock=self.clock)

    def tearDown(self):
        self.journal.close()

    def cue(self, **changes):
        identifier = self.journal.record({**assessment(), **changes})
        self.journal.present(identifier)
        return identifier

    def test_assessment_and_displayed_cue_are_separate_and_idempotent(self):
        identifier = self.journal.record(assessment())
        self.assertEqual(self.journal.query()['summary']['displayed_signals'], 0)
        self.journal.present(identifier); self.journal.present(identifier)
        self.assertEqual(self.journal.query()['summary']['displayed_signals'], 1)
        self.assertEqual(self.journal.query()['summary']['average_latency_ms'], 2500)
        with self.assertRaises(JournalError):
            self.journal.present(self.journal.record(assessment('WAIT')))

    def test_manual_entry_is_idempotent_and_cannot_use_an_expired_or_unshown_cue(self):
        identifier = self.journal.record(assessment())
        with self.assertRaises(JournalError):
            self.journal.entry(identifier)
        self.journal.present(identifier)
        entry = self.journal.entry(identifier, '10', '92')
        self.assertEqual(self.journal.entry(identifier, '10', '92')['id'], entry['id'])
        fresh = self.cue()
        self.clock.return_value = 1021
        with self.assertRaises(JournalError):
            self.journal.entry(fresh)

    def test_actual_payout_net_profit_and_unpriced_results(self):
        win = self.journal.entry(self.cue(), '10', '92')
        loss = self.journal.entry(self.cue(), '10', '92')
        void = self.journal.entry(self.cue(), '10', '92')
        unpriced = self.journal.entry(self.cue())
        with self.assertRaises(JournalError):
            self.journal.outcome(win['id'], 'win')
        self.clock.return_value = 1120
        for row, outcome in [(win, 'win'), (loss, 'loss'), (void, 'void'), (unpriced, 'win')]:
            self.journal.outcome(row['id'], outcome)
        summary = self.journal.query()['summary']
        self.assertEqual(summary['net_units'], -0.8)
        self.assertEqual(summary['priced_results'], 3)
        self.assertEqual(summary['unpriced_results'], 1)
        self.assertEqual(summary['win_rate'], 66.67)
        self.assertEqual(self.journal.outcome(win['id'], 'win')['pnl_minor'], 920)
        with self.assertRaises(JournalError):
            self.journal.outcome(win['id'], 'loss')

    def test_invalid_amounts_never_become_zero_profit(self):
        identifier = self.cue()
        for stake, payout in [(True, 90), ('NaN', 90), (10, 101), (-1, 90), (10, None), (None, 90), (1.001, 90)]:
            with self.subTest(stake=stake, payout=payout), self.assertRaises(JournalError):
                self.journal.entry(identifier, stake, payout)

    def test_file_survives_reopen_without_persisting_image_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'journal.sqlite3'
            journal = VisionJournal(path, clock=self.clock)
            identifier = journal.record({**assessment(), 'image': 'must-not-be-stored'})
            journal.present(identifier)
            entry = journal.entry(identifier)
            journal.close()
            restored = VisionJournal(path, clock=self.clock)
            self.assertEqual(restored.query()['entries'][0]['id'], entry['id'])
            restored.close()
            self.assertNotIn(b'must-not-be-stored', path.read_bytes())


if __name__ == '__main__':
    unittest.main()
