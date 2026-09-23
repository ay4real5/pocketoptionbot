import json
import sqlite3
import threading
import time
import uuid
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP


class JournalError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class VisionJournal:
    def __init__(self, path=':memory:', clock=time.time):
        self.clock = clock
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, timeout=5, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA foreign_keys = ON')
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS assessments (
                id TEXT PRIMARY KEY, captured_at INTEGER NOT NULL, received_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL, asset TEXT NOT NULL, market_type TEXT NOT NULL,
                strategy TEXT NOT NULL, candle_timeframe TEXT NOT NULL, direction TEXT NOT NULL,
                expiry_minutes INTEGER NOT NULL, latency_ms INTEGER NOT NULL, reason TEXT NOT NULL,
                checks TEXT NOT NULL, displayed_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS entries (
                id TEXT PRIMARY KEY, analysis_id TEXT NOT NULL UNIQUE REFERENCES assessments(id),
                entered_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, stake_minor INTEGER,
                payout_bps INTEGER, result TEXT NOT NULL DEFAULT 'open', resolved_at INTEGER, pnl_minor INTEGER
            );
        ''')

    def close(self):
        self.db.close()

    def record(self, value):
        identifier = uuid.uuid4().hex
        with self.lock, self.db:
            self.db.execute('''INSERT INTO assessments
                (id,captured_at,received_at,expires_at,asset,market_type,strategy,candle_timeframe,direction,expiry_minutes,latency_ms,reason,checks)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)''', (
                identifier, value['captured_at'], int(self.clock() * 1000), value['expires_at'], value['asset'],
                value['market_type'], value['strategy'], value['candle_timeframe'], value['direction'], value['expiry_minutes'],
                value.get('latency_ms', 0), value['reason'], json.dumps(value.get('checks', []))))
        return identifier

    def present(self, analysis_id):
        with self.lock, self.db:
            row = self.db.execute('SELECT * FROM assessments WHERE id=?', (analysis_id,)).fetchone()
            if not row:
                raise JournalError('Analysis record not found.', 404)
            if row['displayed_at'] is not None:
                return {'saved': True, 'analysis_id': analysis_id}
            now = int(self.clock() * 1000)
            if row['direction'] not in ('BUY', 'SELL') or not row['captured_at'] <= now < row['expires_at']:
                raise JournalError('Only a fresh BUY/SELL cue can be marked displayed.', 409)
            self.db.execute('UPDATE assessments SET displayed_at=? WHERE id=?', (now, analysis_id))
        return {'saved': True, 'analysis_id': analysis_id}

    @staticmethod
    def amount(value, maximum, name):
        if value is None or value == '':
            return None
        if isinstance(value, bool) or not isinstance(value, (str, int, float)):
            raise JournalError(f'Invalid {name}.')
        try:
            decimal = Decimal(str(value))
        except InvalidOperation:
            raise JournalError(f'Invalid {name}.') from None
        if not decimal.is_finite() or not 0 < decimal <= maximum or decimal.as_tuple().exponent < -2:
            raise JournalError(f'{name} must be positive, at most {maximum}, with no more than two decimal places.')
        return int(decimal * 100)

    def entry(self, analysis_id, stake=None, payout_percent=None):
        stake_minor = self.amount(stake, 1000000, 'Stake')
        payout_bps = self.amount(payout_percent, 100, 'Profit payout percentage')
        if (stake_minor is None) != (payout_bps is None):
            raise JournalError('Enter both stake and payout, or leave both blank for an unpriced record.')
        with self.lock, self.db:
            existing = self.db.execute('SELECT * FROM entries WHERE analysis_id=?', (analysis_id,)).fetchone()
            if existing:
                return dict(existing)
            signal = self.db.execute('SELECT * FROM assessments WHERE id=?', (analysis_id,)).fetchone()
            now = int(self.clock() * 1000)
            if not signal or signal['displayed_at'] is None or signal['direction'] not in ('BUY', 'SELL'):
                raise JournalError('Record a displayed chart-assistant cue first.', 409)
            if not signal['captured_at'] <= now < signal['expires_at']:
                raise JournalError('This cue has expired; no new entry was recorded.', 409)
            identifier = uuid.uuid4().hex
            self.db.execute('''INSERT INTO entries (id,analysis_id,entered_at,expires_at,stake_minor,payout_bps)
                               VALUES (?,?,?,?,?,?)''', (identifier, analysis_id, now, now + signal['expiry_minutes'] * 60000, stake_minor, payout_bps))
            return dict(self.db.execute('SELECT * FROM entries WHERE id=?', (identifier,)).fetchone())

    def outcome(self, entry_id, result):
        if result not in ('win', 'loss', 'void'):
            raise JournalError('Choose Win, Loss, or Tie / void.')
        with self.lock, self.db:
            row = self.db.execute('SELECT * FROM entries WHERE id=?', (entry_id,)).fetchone()
            if not row:
                raise JournalError('Demo entry not found.', 404)
            if row['result'] != 'open':
                if row['result'] == result:
                    return dict(row)
                raise JournalError('This entry already has a reported result.', 409)
            now = int(self.clock() * 1000)
            if now < row['expires_at']:
                raise JournalError('Wait for the manual timer to finish and check the platform result.', 409)
            profit = None
            if row['stake_minor'] is not None:
                profit = (-row['stake_minor'] if result == 'loss' else 0 if result == 'void' else
                          int((Decimal(row['stake_minor']) * row['payout_bps'] / 10000).quantize(Decimal('1'), rounding=ROUND_HALF_UP)))
            self.db.execute('UPDATE entries SET result=?,resolved_at=?,pnl_minor=? WHERE id=?', (result, now, profit, entry_id))
            return dict(self.db.execute('SELECT * FROM entries WHERE id=?', (entry_id,)).fetchone())

    def query(self):
        with self.lock:
            signals = [dict(row) for row in self.db.execute('''SELECT id,asset,market_type,strategy,direction,captured_at,displayed_at,latency_ms
                FROM assessments ORDER BY received_at DESC,rowid DESC LIMIT 50''')]
            entries = [dict(row) for row in self.db.execute('''SELECT e.*,a.asset,a.direction,a.strategy,a.market_type
                FROM entries e JOIN assessments a ON a.id=e.analysis_id ORDER BY entered_at DESC,e.rowid DESC LIMIT 50''')]
            totals = dict(self.db.execute('''SELECT COUNT(*) AS analyses,COUNT(displayed_at) AS displayed_signals,
                AVG(latency_ms) AS average_latency_ms FROM assessments''').fetchone())
            rows = self.db.execute('SELECT result,COUNT(*) AS n,COUNT(pnl_minor) AS priced,COALESCE(SUM(pnl_minor),0) AS pnl FROM entries GROUP BY result').fetchall()
            counts = {row['result']: row['n'] for row in rows}
            wins, losses = counts.get('win', 0), counts.get('loss', 0)
            totals.update(wins=wins, losses=losses, void=counts.get('void', 0), open=counts.get('open', 0),
                          win_rate=round(wins / (wins + losses) * 100, 2) if wins + losses else None,
                          priced_results=sum(row['priced'] for row in rows), net_units=sum(row['pnl'] for row in rows) / 100,
                          unpriced_results=sum(row['n'] - row['priced'] for row in rows if row['result'] != 'open'))
            groups = [dict(row) for row in self.db.execute('''SELECT a.strategy,a.market_type,COUNT(*) AS entries,
                SUM(e.result='win') AS wins,SUM(e.result='loss') AS losses,
                COUNT(e.pnl_minor) AS priced_results,COALESCE(SUM(e.pnl_minor),0)/100.0 AS net_units
                FROM entries e JOIN assessments a ON a.id=e.analysis_id GROUP BY a.strategy,a.market_type''')]
        return {'signals': signals, 'entries': entries, 'summary': totals, 'groups': groups}

    def dispatch(self, action, payload):
        if not isinstance(payload, dict):
            raise JournalError('Invalid journal request.')
        if action == 'query':
            return self.query()
        key = payload.get('entry_id' if action == 'outcome' else 'analysis_id')
        if not isinstance(key, str) or len(key) != 32:
            raise JournalError('Invalid journal record ID.')
        if action == 'present':
            return self.present(key)
        if action == 'entry':
            return self.entry(key, payload.get('stake'), payload.get('payout_percent'))
        if action == 'outcome':
            return self.outcome(key, payload.get('result'))
        raise JournalError('Unknown journal action.', 404)
