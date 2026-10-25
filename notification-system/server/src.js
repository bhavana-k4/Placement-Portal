import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import webpush from 'web-push';
import crypto from 'node:crypto';

const required = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT', 'NOTIFICATION_EVENT_SECRET'];
for (const key of required) if (!process.env[key]) console.warn(`Missing environment variable: ${key}`);
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
}

const app = express();
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || 'http://localhost:5173' }));
app.use(express.json({ limit: '64kb' }));
const db = new Database(process.env.DB_PATH || './notifications.sqlite');
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY, student_id TEXT NOT NULL, type TEXT NOT NULL,
    title TEXT NOT NULL, message TEXT NOT NULL, link TEXT,
    created_at TEXT NOT NULL, read_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_student ON notifications(student_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY, student_id TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE,
    subscription_json TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_subscriptions_student ON push_subscriptions(student_id);
`);

const EVENT_TYPES = new Set([
  'eligible_job_posted', 'deadline_approaching', 'shortlisted', 'interview_scheduled',
  'application_rejected', 'internship_verified', 'internship_rejected', 'placement_selected'
]);
const now = () => new Date().toISOString();
const makeId = () => crypto.randomUUID();
const cleanText = (value, max = 500) => String(value ?? '').trim().slice(0, max);

app.get('/health', (_req, res) => res.json({ ok: true, service: 'dmce-notification-service' }));
app.get('/api/config', (_req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY) return res.status(503).json({ error: 'Push notifications are not configured.' });
  res.json({ vapidPublicKey: process.env.VAPID_PUBLIC_KEY });
});

// MVP endpoint. Before production, replace student_id supplied by browser with an identity
// verified from the portal's authenticated session/JWT. Never trust a client-provided student ID alone.
app.post('/api/notifications/subscribe', (req, res) => {
  const studentId = cleanText(req.body?.studentId, 100);
  const subscription = req.body?.subscription;
  if (!studentId || !subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: 'studentId and a valid push subscription are required.' });
  }
  db.prepare(`INSERT INTO push_subscriptions (id, student_id, endpoint, subscription_json, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET student_id=excluded.student_id, subscription_json=excluded.subscription_json`)
    .run(makeId(), studentId, subscription.endpoint, JSON.stringify(subscription), now());
  res.status(201).json({ success: true, message: 'This browser is registered for push notifications.' });
});

app.get('/api/notifications/:studentId', (req, res) => {
  const studentId = cleanText(req.params.studentId, 100);
  if (!studentId) return res.status(400).json({ error: 'studentId is required.' });
  const rows = db.prepare('SELECT id, type, title, message, link, created_at, read_at FROM notifications WHERE student_id=? ORDER BY created_at DESC LIMIT 100').all(studentId);
  res.json({ notifications: rows, unreadCount: rows.filter(row => !row.read_at).length });
});

app.patch('/api/notifications/:id/read', (req, res) => {
  const studentId = cleanText(req.body?.studentId, 100);
  if (!studentId) return res.status(400).json({ error: 'studentId is required.' });
  const result = db.prepare('UPDATE notifications SET read_at=? WHERE id=? AND student_id=?').run(now(), cleanText(req.params.id, 100), studentId);
  res.json({ success: result.changes > 0 });
});
app.patch('/api/notifications/read-all', (req, res) => {
  const studentId = cleanText(req.body?.studentId, 100);
  if (!studentId) return res.status(400).json({ error: 'studentId is required.' });
  db.prepare('UPDATE notifications SET read_at=? WHERE student_id=? AND read_at IS NULL').run(now(), studentId);
  res.json({ success: true });
});

// Server-to-server event API. Call this only from trusted backend code, never directly from the browser.
app.post('/api/events', async (req, res) => {
  const supplied = req.get('x-notification-secret') || '';
  const expected = process.env.NOTIFICATION_EVENT_SECRET || '';
  if (!expected || supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    return res.status(401).json({ error: 'Unauthorized event sender.' });
  }
  const { type, studentIds, title, message, link } = req.body || {};
  if (!EVENT_TYPES.has(type)) return res.status(400).json({ error: 'Unsupported notification type.' });
  if (!Array.isArray(studentIds) || studentIds.length < 1 || studentIds.length > 5000) return res.status(400).json({ error: 'studentIds must be an array containing 1 to 5000 student IDs.' });
  const safeTitle = cleanText(title, 120);
  const safeMessage = cleanText(message, 1000);
  if (!safeTitle || !safeMessage) return res.status(400).json({ error: 'title and message are required.' });
  const create = db.prepare('INSERT INTO notifications (id, student_id, type, title, message, link, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const getSubs = db.prepare('SELECT id, endpoint, subscription_json FROM push_subscriptions WHERE student_id=?');
  const deleteSub = db.prepare('DELETE FROM push_subscriptions WHERE id=?');
  let saved = 0, pushSent = 0, pushFailed = 0;
  const uniqueIds = [...new Set(studentIds.map(id => cleanText(id, 100)).filter(Boolean))];
  for (const studentId of uniqueIds) {
    create.run(makeId(), studentId, type, safeTitle, safeMessage, cleanText(link, 500) || null, now());
    saved++;
    const subscriptions = getSubs.all(studentId);
    for (const row of subscriptions) {
      try {
        await webpush.sendNotification(JSON.parse(row.subscription_json), JSON.stringify({ title: safeTitle, body: safeMessage, url: cleanText(link, 500) || '/' }), { TTL: 60 * 60 * 24 });
        pushSent++;
      } catch (error) {
        pushFailed++;
        if (error.statusCode === 404 || error.statusCode === 410) deleteSub.run(row.id);
        else console.error('Push delivery failed:', error.statusCode || error.message);
      }
    }
  }
  res.status(201).json({ success: true, saved, pushSent, pushFailed, students: uniqueIds.length });
});

const port = Number(process.env.PORT || 8788);
app.listen(port, () => console.log(`DMCE notification service listening on http://localhost:${port}`));
