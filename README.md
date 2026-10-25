# Go Rides

**Your everyday commute, sorted.** *Your driver. Your schedule. Your ride.*

Go Rides is a subscription-based transport platform for South African commuters. Passengers set up their trips to work and back once, choose a verified regular driver, and pay monthly or from a prepaid ride balance. Go Rides books every ride a week ahead, lines up backup drivers, and sends reminders and updates on WhatsApp, SMS or email.

This repository is the first version: a mobile-first web app with passenger, driver, admin and employer dashboards.

## Quick start

```bash
npm install
npm run seed     # demo accounts and two weeks of activity
npm start        # http://localhost:3000
npm test         # booking, billing and payment tests
```

Requires Node 22.5 or newer. The app uses Node's built-in SQLite and Express, and needs no build step.

### Demo logins (password `gorides123`)

| Email | Role |
| --- | --- |
| `admin@gorides.test` | Operations admin |
| `zanele@gorides.test` | Passenger on the Daily Commuter plan |
| `kagiso@gorides.test` | Passenger using a prepaid ride balance |
| `precious@gorides.test` | Employee whose rides are paid by Ubuntu Logistics |
| `thabo@gorides.test` | Driver (also `lindiwe@`, `sipho@`; `ayanda@` is waiting for verification) |
| `hr@ubuntu.test` | Employer account |

## What it does

| Need | Where it lives |
| --- | --- |
| Passenger registration with home, work, area, distance and emergency contact | `/register` |
| Recurring trips (for example Mon to Fri, 07:00 and 17:00) | Passenger → Schedule |
| Preferred driver and approved backup drivers | Passenger → Drivers |
| Automatic booking a week ahead, with backup allocation | `src/booking.js` |
| Monthly plans, prepaid ride packs, renewals and reminders | Passenger → Plans & pay, `src/payments.js` |
| Charging each completed trip to the plan, employer or ride balance | `settleTrip` in `src/booking.js` |
| Pickup reminders, driver changes, delays and arrival alerts | `src/notify.js` |
| Live driver location, shareable trip link for family, SOS button | Passenger trip page, `/t/<link>` |
| Driver availability, time off, trip status updates, earnings | Driver dashboard |
| Driver verification (ID, licence, PrDP), suspension | Admin → Drivers |
| Dispatch: reassign or cancel trips, see trips without a driver | Admin → Trips |
| Ratings, complaints, SOS alerts, credits and refunds | Passenger trip page, Admin → Support / Passengers |
| Operations analytics: today, month, on-time rate, demand by area | Admin → Overview |
| Employer accounts: add staff, monthly report and invoice amount | `/business` |

### How a driver is chosen

For each booked trip, `pickDriver` tries in order:

1. the passenger's preferred driver;
2. backup drivers the passenger has approved;
3. the best-rated, least-busy verified driver in the passenger's area;
4. any verified driver.

A driver qualifies only if they are approved, available at that time on that weekday, not on time off, and have no other trip within 60 minutes. If nobody qualifies, the trip shows as *Finding driver*, admins are alerted, and the next booking run (every five minutes) tries again. When a driver books time off or is suspended, their trips move to backups and passengers are told who is coming instead.

A passenger is only booked when they can pay for the ride: an active plan, an employer, or enough ride balance for the rides already booked.

### Pricing

All pricing is set by admins under **Pricing** and applies to new bookings. The defaults are placeholders to adjust against real costs:

- Fare per trip: R10 + R2.20/km, at least R25. A 15 km trip costs R43.
- Plans: Daily Commuter (44 trips, 15% off), Part-time (26 trips, 10% off), Flexi (18 trips, 5% off).
- Ride packs: 10, 20 (5% off) or 40 rides (8% off), credited to a Rand balance.
- Drivers keep 80% of each fare. For plan trips, the fare is the plan price divided by its trips.

## Before going live

1. **Payments.** Add PayFast merchant details to `.env` (see `.env.example`). Until then, checkout is a clearly labelled test page. Plan renewals currently create a payment request each month. For automatic card debits, move to PayFast tokenised subscriptions.
2. **Messaging.** Add WhatsApp Cloud API, Clickatell (SMS) and Resend (email) keys. Without them, messages are recorded in each user's in-app inbox and marked *simulated*. WhatsApp messages sent outside a 24-hour customer window need Meta-approved templates.
3. **Driver vetting.** The app records ID, licence and PrDP numbers. Before approving a driver, check the originals and run a criminal record check. Confirm operating licence requirements under the National Land Transport Act with a transport attorney.
4. **POPIA.** Have the privacy notice, consent wording and data retention reviewed. Location is shared only while a trip is under way.
5. **Hosting.** Run it on any Node host with a persistent disk for `DATABASE_PATH` (for example a small VPS, Render or Fly.io), behind HTTPS, with `NODE_ENV=production` and `SITE_URL` set. Back up the SQLite file daily. Move to PostgreSQL when you run more than one server.
6. **Distances.** Passengers enter an estimated distance. Add a maps API (such as Google Distance Matrix) to calculate it from their addresses.

## Roadmap

- Shared rides: several passengers on one route for a lower price, the main lever on affordability.
- Android and iOS apps. The site already installs to the home screen and works on low-end phones.
- Automatic weekly driver payouts and invoices for employers.
- Student, shift-worker and airport transfer plans.

## Project layout

```
src/
  server.js      Express app and five-minute booking loop
  db.js          SQLite schema, default settings and plans
  booking.js     Trip booking, driver allocation, reminders, billing, renewals
  pricing.js     Fares, plan and pack prices
  payments.js    PayFast checkout and notification handling
  notify.js      In-app, WhatsApp, SMS and email notifications
  routes/        Public, passenger, driver, admin and business pages
  views/         HTML templating and layout
public/          CSS, small client script (tracking, sharing, location), icon
test/            Node test runner tests
```
