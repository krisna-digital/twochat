import { sb } from './api.js';

// Satu channel privat: perubahan tabel (dilindungi RLS), presence (online) dan broadcast (mengetik).
// Channel privat diotorisasi oleh policy pada realtime.messages (lihat sql/01_setup.sql).
export function openChannel(ctx, h) {
  const ch = sb.channel('room', {
    config: { private: true, presence: { key: ctx.userId }, broadcast: { self: false } }
  });
  ch.on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, (p) => h.onMessage(p))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'room_state' }, (p) => h.onRoomState(p.new))
    .on('presence', { event: 'sync' }, () => h.onPresence(ch.presenceState()))
    .on('broadcast', { event: 'typing' }, (m) => h.onTyping(m && m.payload))
    .subscribe(async (status) => {
      h.onStatus(status);
      if (status === 'SUBSCRIBED') {
        try { await ch.track({ user: ctx.username, at: Date.now() }); } catch { /* abaikan */ }
      }
    });
  return ch;
}

export function closeChannel(ch) {
  if (!ch) return;
  try { sb.removeChannel(ch); } catch { /* abaikan */ }
}

export function peerIsOnline(presenceState, myUserId) {
  return Object.keys(presenceState || {}).some((k) => k !== myUserId);
}
