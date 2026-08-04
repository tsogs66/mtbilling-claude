# Local PC ↔ Hub database sync

MT-Billing can run as a full install on a **local PC** (USB flash image, install-to-disk, or normal Node install) while staying in sync with a central **Hub** server.

## Roles

| Role | Where | Behavior |
|------|--------|----------|
| **Standalone** | Default | No sync |
| **Hub** | Central server | Accepts pull/push from edge PCs using a shared sync token |
| **Edge** | Local PC | Works offline on its own SQLite; queues changes; when online pulls latest hub data and pushes held changes |

## Setup

1. On the **hub** (System Settings → **Local PC Sync**):
   - Role: Hub
   - Enable sync
   - Copy the **shared sync token** (or rotate once and copy)
2. Install MT-Billing on the **PC** the same way as a normal panel (flash USB / LXC / Node).
3. On the **PC**:
   - Role: Edge
   - Hub URL: `https://your-hub` or `http://192.168.x.x`
   - Paste the **same sync token**
   - Enable sync → Save
4. Click **Sync now** (or wait for the background scheduler ~2 minutes).

## Offline behavior

While the hub is unreachable, the edge PC keeps serving the local panel. Row changes are **held in `sync_outbox`** (coalesced per entity — latest state wins, same idea as `router_sync_queue`). When the hub is reachable again, the edge:

1. **Pulls** a merge snapshot from the hub (latest clients, billing, network, ops, …)
2. **Pushes** held outbox rows to the hub

Failed pushes use exponential backoff and stay queued until they succeed.

## Notes

- Edge `sync_*` settings are preserved when applying hub `app_settings`.
- Prefer one writer per subscriber when possible; conflicts resolve as last upsert wins on primary key.
- Sync APIs: `GET /api/sync/hello`, `GET /api/sync/pull`, `POST /api/sync/push` (Bearer sync token). Staff UI uses `/api/sync/status`, `/api/sync/settings`, `/api/sync/now`.
