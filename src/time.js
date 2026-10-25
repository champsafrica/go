// South Africa has a single time zone (SAST, UTC+2) and no daylight saving, so all
// scheduling works in local date strings (YYYY-MM-DD) and times (HH:MM).
export const TZ = 'Africa/Johannesburg';

export function nowLocal(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-ZA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(date).map(p => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function addMonths(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

// ISO weekday: 1 = Monday ... 7 = Sunday.
export function weekday(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

export function toMinutes(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

export function fromMinutes(mins) {
  const h = Math.floor(mins / 60) % 24;
  return `${String(h).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function formatDate(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('en-ZA', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC'
  });
}
