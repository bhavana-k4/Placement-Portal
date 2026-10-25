import React, { useCallback, useEffect, useState } from 'react';
import './NotificationCenter.css';

const API = (import.meta.env.VITE_NOTIFICATION_API_URL || 'http://localhost:8788').replace(/\/$/, '');
const studentId = () => localStorage.getItem('gr_number') || localStorage.getItem('user_id') || '';
const decodeKey = (base64) => {
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
};

export default function NotificationCenter() {
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const id = studentId();

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const response = await fetch(`${API}/api/notifications/${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error('Could not load notifications.');
      const data = await response.json();
      setItems(data.notifications || []);
      setUnread(data.unreadCount || 0);
    } catch (error) { setMessage(error.message || 'Notification service is unavailable.'); }
  }, [id]);

  useEffect(() => { refresh(); }, [refresh]);

  const enablePush = async () => {
    setMessage(''); setBusy(true);
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        throw new Error('This browser does not support web push notifications. Try a current version of Chrome or Edge over HTTPS.');
      }
      if (!id) throw new Error('Your student ID was not found. Sign in again first.');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('Notification permission was not granted in your browser.');
      const configResponse = await fetch(`${API}/api/config`);
      if (!configResponse.ok) throw new Error('Push service is not configured yet. Check the notification server setup.');
      const { vapidPublicKey } = await configResponse.json();

      const registration = await navigator.serviceWorker.register('/sw.js');

      // Wait until the browser confirms that a service worker is active.
      const readyRegistration = await navigator.serviceWorker.ready;

      // Subscribe using the active registration.
      const subscription = await readyRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeKey(vapidPublicKey)
      });

      const response = await fetch(`${API}/api/notifications/subscribe`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentId: id, subscription: subscription.toJSON() })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not register this browser.');
      setMessage('Push notifications enabled for this browser.');
    } catch (error) { setMessage(error.message || 'Could not enable notifications.'); }
    finally { setBusy(false); }
  };

  const markRead = async (item) => {
    try {
      await fetch(`${API}/api/notifications/${encodeURIComponent(item.id)}/read`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ studentId: id })
      });
      setItems(current => current.map(row => row.id === item.id ? { ...row, read_at: row.read_at || new Date().toISOString() } : row));
      setUnread(current => Math.max(0, current - (item.read_at ? 0 : 1)));
    } catch { setMessage('Could not update read status.'); }
  };

  const markAllRead = async () => {
    await fetch(`${API}/api/notifications/read-all`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ studentId: id }) });
    setItems(current => current.map(row => ({ ...row, read_at: row.read_at || new Date().toISOString() })));
    setUnread(0);
  };

  return <div className="notification-center">
    <button className="notification-bell" type="button" onClick={() => setOpen(value => !value)} aria-label={`Notifications, ${unread} unread`}>
      🔔 {unread > 0 && <span className="notification-count">{unread > 99 ? '99+' : unread}</span>}
    </button>
    {open && <section className="notification-panel" aria-label="Notifications">
      <header className="notification-panel-header"><strong>Notifications</strong><button type="button" onClick={refresh}>Refresh</button></header>
      <button className="notification-enable" type="button" disabled={busy} onClick={enablePush}>{busy ? 'Enabling…' : 'Enable browser push notifications'}</button>
      {message && <p className="notification-message" role="status">{message}</p>}
      {unread > 0 && <button className="notification-mark-all" type="button" onClick={markAllRead}>Mark all as read</button>}
      {items.length === 0 ? <p className="notification-empty">No notifications yet.</p> : <ul className="notification-list">{items.map(item => <li key={item.id} className={item.read_at ? 'notification-item' : 'notification-item unread'}>
        <button type="button" className="notification-item-button" onClick={() => { markRead(item); if (item.link) window.location.href = item.link; }}>
          <strong>{item.title}</strong><span>{item.message}</span><time>{new Date(item.created_at).toLocaleString()}</time>
        </button>
      </li>)}</ul>}
    </section>}
  </div>;
}
