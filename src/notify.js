// Every notification lands in the user's in-app inbox, then goes out on the channels the
// user chose (WhatsApp, SMS, email). A channel without credentials is simulated: the
// message is logged and recorded as "simulated" so the flow can be tested end to end.

import { background } from './background.js';

const env = process.env;

const providers = {
  async whatsapp(user, title, body) {
    if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID || !user.phone) return 'simulated';
    // WhatsApp Cloud API. Business-initiated messages outside the 24-hour window need an
    // approved template; replace this text message with a template call before launch.
    const res = await fetch(`https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to: msisdn(user.phone), type: 'text',
        text: { body: `*${title}*\n${body}` }
      })
    });
    return res.ok ? 'sent' : `failed ${res.status}`;
  },
  async sms(user, title, body) {
    if (!env.CLICKATELL_API_KEY || !user.phone) return 'simulated';
    const res = await fetch('https://platform.clickatell.com/v1/message', {
      method: 'POST',
      headers: { Authorization: env.CLICKATELL_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ channel: 'sms', to: msisdn(user.phone), content: `${title}: ${body}` }] })
    });
    return res.ok ? 'sent' : `failed ${res.status}`;
  },
  async email(user, title, body) {
    if (!env.RESEND_API_KEY) return 'simulated';
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: user.email, subject: title, text: body })
    });
    return res.ok ? 'sent' : `failed ${res.status}`;
  }
};

// South African numbers: 082 123 4567 -> 27821234567
export function msisdn(phone) {
  const digits = String(phone).replace(/\D/g, '');
  return digits.startsWith('0') ? `27${digits.slice(1)}` : digits;
}

export async function notify(db, userId, title, body) {
  const user = await db.prepare('SELECT id, email, phone, channels FROM users WHERE id = ?').get(userId);
  if (!user) return;
  const { lastInsertRowid } = await db.prepare('INSERT INTO notifications (user_id, title, body) VALUES (?, ?, ?)')
    .run(userId, title, body);
  const channels = user.channels.split(',').filter(c => providers[c]);
  if (env.NODE_ENV === 'test' || channels.length === 0) return;
  // Delivery runs in the background so a slow provider never blocks a request or a
  // booking run. It records the outcome outside any transaction the caller may be in.
  background(Promise.all(channels.map(async c => {
    try { return `${c}:${await providers[c](user, title, body)}`; }
    catch (err) { return `${c}:error ${err.message}`; }
  })).then(async results => {
    if (results.some(r => r.endsWith('simulated'))) console.log(`[notify] ${user.email}: ${title} (${results.join(' ')})`);
    // A notification made inside a transaction that rolled back no longer exists; that is fine.
    await db.root.prepare('UPDATE notifications SET deliveries = ? WHERE id = ?').run(results.join(' '), lastInsertRowid);
  }));
}

export async function notifyAdmins(db, title, body) {
  for (const { id } of await db.prepare("SELECT id FROM users WHERE role = 'admin'").all()) await notify(db, id, title, body);
}

// For people without a Go Rides account, such as a passenger's emergency contact.
export function sendDirect(phone, text) {
  const contact = { phone, email: null };
  if (env.NODE_ENV === 'test') return;
  background(Promise.all([providers.sms(contact, 'Go Rides', text), providers.whatsapp(contact, 'Go Rides', text)])
    .then(r => console.log(`[notify] direct to ${phone}: ${r.join(' ')}`)));
}

// Email to someone without a Go Rides account, such as a gift card recipient.
export function sendDirectEmail(email, subject, text) {
  if (env.NODE_ENV === 'test') return;
  background(providers.email({ email, phone: null }, subject, text)
    .then(r => console.log(`[notify] email to ${email}: ${r}`)));
}
