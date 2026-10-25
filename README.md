# Go Rides

<img src="public/brand/go-rides-logo.png" alt="Go Rides" height="60">

A Go Ads service ([www.goads.co.za](https://www.goads.co.za)).

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

Requires Node 22. The app is Express with a SQLite database (through the libSQL client, so the same code runs on a local file or a hosted Turso database), and needs no build step.

### Demo logins (password `gorides123`)

| Email | Role |
| --- | --- |
| `admin@gorides.test` | Operations admin |
| `zanele@gorides.test` | Passenger on the Daily Commuter plan, sharing rides |
| `bongani@gorides.test` | Passenger sharing Thabo's car with Zanele |
| `kagiso@gorides.test` | Passenger using a prepaid ride balance |
| `precious@gorides.test` | Employee whose rides are paid by Ubuntu Logistics |
| `thabo@gorides.test` | Driver (also `lindiwe@`, `sipho@`; `ayanda@` is waiting for verification) |
| `hr@ubuntu.test` | Employer account |

## What it does

| Need | Where it lives |
| --- | --- |
| Passenger registration with home, work, area, distance and emergency contact | `/register` |
| Recurring trips (for example Mon to Fri, 07:00 and 17:00) | Passenger → Schedule |
| Shared rides: neighbours on the same route share a car and pay less | Passenger → Schedule or Home |
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

### Shared rides

Passengers can choose to share their rides, at sign-up or later, for a discount on every fare (30% by default). Two sharers can ride in the same car when:

- they live in the same area and work in the same area;
- they travel in the same direction on the same day;
- their pickup times are no more than 20 minutes apart (admins can change this);
- the car has a free seat.

When booking a shared trip, Go Rides keeps the passenger's preferred driver if they are free, or their car still has a matching seat. Otherwise it fills cars that already carry matching sharers, fullest first, before using a new driver. Sharers pay the shared price even when nobody joins them, so the price is predictable. Solo passengers are never placed in a shared car.

The driver sees the order of pickups for each shared car, and each passenger sees the first names of the people they ride with. Drivers are paid their share of every passenger's fare, so a full car earns more than a solo trip. When someone stops sharing, their upcoming rides go back to the solo price. Any ride that can no longer stay in its car moves to another driver, and each person affected gets one message.

The admin overview shows the share of trips that were shared, the average riders per shared car, and how many passengers share in each area.

A passenger is only booked when they can pay for the ride: an active plan, an employer, or enough ride balance for the rides already booked.

### Pricing

All pricing is set by admins under **Pricing** and applies to new bookings. The defaults are placeholders to adjust against real costs:

- Fare per trip: R10 + R2.20/km, at least R25. A 15 km trip costs R43.
- Plans: Daily Commuter (44 trips, 15% off), Part-time (26 trips, 10% off), Flexi (18 trips, 5% off).
- Ride packs: 10, 20 (5% off) or 40 rides (8% off), credited to a Rand balance.
- Shared rides: 30% off every fare, plan and pack. A 15 km shared trip costs R30, and the Daily Commuter plan for that distance comes to R1,122 a month instead of R1,608.
- Drivers keep 80% of each fare. For plan trips, the fare is the plan price divided by its trips.

## Brand

Go Rides shares the Go Ads identity from [www.goads.co.za](https://www.goads.co.za):

- **Logo:** `public/brand/go-rides-logo.png` keeps the "Go" (with the map-pin "o") from the Go Ads wordmark, and sets "rides" in Fredoka Bold in the same orange with a white outline. The favicon is the Go Ads pin mark, and the app icons are PNG versions of it.
- **Colours:** Go Ads orange `#ff4d00`, forest `#072014` and mint `#86ffb4` as accents in a black-and-white layout modelled on uber.com. Buttons are black, or white on dark sections, which keeps their text easy to read.
- **Font:** Poppins throughout, self-hosted in `public/fonts/` under the SIL Open Font License.
- **Illustrations:** `public/illustrations/` holds flat SVG drawings in the brand colours (car, shared ride, ride pack, business, driving, safety, calendar, route) and the hero route map. Photographs of your own drivers and cars would make the landing page stronger; they can replace any illustration.

## Deploying to Vercel

The repository deploys to Vercel as it is. Vercel detects the Express app in `src/server.js` and serves `public/` from its CDN.

**Without a database, Vercel runs a demo.** Vercel's file system is temporary, so with no database connected, Go Rides keeps its data in a throwaway SQLite file, fills it with the sample accounts, and shows a *Demo* banner on every page. Anything saved there can disappear whenever Vercel starts a fresh copy of the app, and separate copies do not share data.

**To keep real data, connect Turso:**

1. In the Vercel project, open **Storage**, choose **Turso** from the Marketplace, create a database (pick a region close to your Vercel functions) and connect it to the project. This adds `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`. If you create the database on turso.tech instead, add those two variables yourself.
2. Under **Settings > Environment Variables**, add:
   - `SETUP_CODE`: any long random phrase, used once to create the admin account;
   - `CRON_SECRET`: another long random phrase, which protects the booking job;
   - `SITE_URL`: the address people use, if it is not the project's `.vercel.app` address.
3. Redeploy. The tables are created on the first request.
4. Open `/setup` on the site, enter the setup code and create your admin account. The page then closes for good. Remove `SETUP_CODE` afterwards.

**Booking runs:** Vercel only runs code while it answers a request. Go Rides books upcoming rides, sends pickup reminders and handles renewals when it is visited (at most every five minutes). `vercel.json` also runs it once a day through Vercel Cron, which is all the Hobby plan allows. Pickup reminders need a run every few minutes even when nobody is browsing, so either use a Pro plan and change the schedule in `vercel.json` to `*/5 * * * *`, or ask a free service such as cron-job.org to call `https://<your site>/api/cron` every five minutes with the header `Authorization: Bearer <CRON_SECRET>`.

**Preview links ask for a Vercel login.** Vercel protects deployment URLs such as `go-xxxx-digitalx1.vercel.app` by default. The project's production domain is public. Change this under **Settings > Deployment Protection**.

## Before going live

1. **Web address.** Go Rides uses the Go Ads domain for now: set `SITE_URL=https://www.goads.co.za`. The app's pages sit at the root of whatever address serves it (`/login`, `/passenger` and so on), so it cannot run on the same host as the existing Go Ads website. Serve it from a subdomain such as `rides.goads.co.za`, and link to it from www.goads.co.za. Set `SITE_URL` to whichever address it runs on, because trip-sharing links and PayFast callbacks use it.
2. **Payments.** Add PayFast merchant details to `.env` (see `.env.example`). Until then, checkout is a clearly labelled test page. Plan renewals currently create a payment request each month. For automatic card debits, move to PayFast tokenised subscriptions.
3. **Messaging.** Add WhatsApp Cloud API, Clickatell (SMS) and Resend (email) keys. Without them, messages are recorded in each user's in-app inbox and marked *simulated*. WhatsApp messages sent outside a 24-hour customer window need Meta-approved templates.
4. **Driver vetting.** The app records ID, licence and PrDP numbers. Before approving a driver, check the originals and run a criminal record check. Confirm operating licence requirements under the National Land Transport Act with a transport attorney.
5. **POPIA.** Have the privacy notice, consent wording and data retention reviewed. Location is shared only while a trip is under way.
6. **Hosting and data.** On Vercel, connect Turso as described above; Turso keeps backups and point-in-time restore. On any other Node host, either set the same Turso variables or give `DATABASE_PATH` a persistent disk and back the file up daily.
7. **Distances and matching.** Passengers enter an estimated distance, and shared rides are matched by home and work area. Add a maps API (such as Google Distance Matrix) to calculate distances from addresses. That would also let sharers be matched by actual detour time instead of area.
8. **Shared-ride costs.** Sharers pay the shared price even when they ride alone, so watch *Riders per shared car* on the admin overview. At 30% off, a shared car needs more than about 1.4 riders on average before the driver and Go Rides each earn more from it than from a solo ride.

## Roadmap

- Shared-ride preferences, such as riding only with women passengers, and matching by detour time once addresses are mapped.
- Android and iOS apps. The site already installs to the home screen and works on low-end phones.
- Automatic weekly driver payouts and invoices for employers.
- Student, shift-worker and airport transfer plans.

## Project layout

```
src/
  server.js      Express app (Vercel's entry point), cron endpoint and booking trigger
  db.js          Database connection (local file or Turso), schema, default settings and plans
  seed.js        Demo accounts and sample history
  booking.js     Trip booking, driver allocation, reminders, billing, renewals
  pricing.js     Fares, plan and pack prices
  payments.js    PayFast checkout and notification handling
  notify.js      In-app, WhatsApp, SMS and email notifications
  background.js  Work that finishes after the response (Vercel waitUntil)
  routes/        Public, passenger, driver, admin and business pages
  views/         HTML templating and layout
public/          CSS, small client script (tracking, sharing, location), icon
test/            Node test runner tests
```
