# Notification System Add-on

See [INTEGRATION_GUIDE.md](./INTEGRATION_GUIDE.md) for setup, commands, integration points, testing and production security requirements.

Files:
- `server/`: Node.js + Express + SQLite + Web Push service.
- `frontend/NotificationCenter.jsx`: React notification bell/inbox and push permission flow.
- `frontend/NotificationCenter.css`: styles.
- `../dmce_frontend/public/sw.js`: service worker to display background notifications and handle clicks.

This is an MVP add-on and is not automatically wired to every portal event. Follow the integration guide and security checklist before production use.
