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
| On-time Promise: late pickups and missed rides become ride credit automatically | `settleTrip`, `creditMissedTrips` in `src/booking.js` |
| Price Lock: the monthly price is fixed for the plan's period | Passenger → Plans & pay |
| Go Parcels: parcels ride along on scheduled commuter runs, delivered against a code | `/parcels`, `src/parcels.js` |
| Earnings forecast: drivers see the next 7 days of booked income | Driver → Today and Earnings |
| Installable web app with bottom navigation and offline screen | `/app`, `public/manifest.webmanifest`, `public/sw.js` |
| Live arrival detection and measured lateness | `src/location.js`, Driver → Today, Passenger → Your details |
| Gift cards: buy, pay, deliver by SMS/email, redeem into a ride balance; complimentary cards | `/gift-cards`, Admin → Gift cards, `src/giftcards.js` |
| Partnerships: application form and admin pipeline | `/partnerships`, Admin → Partners |
| How it works: the whole system from A to Z, using live settings | `/how-it-works` |
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

### What sets Go Rides apart

On-demand apps price each trip on the spot, send whichever driver is nearest, and leave drivers guessing about tomorrow. Because every Go Rides trip is planned, it can promise more:

- **Price Lock.** A Go Pass price is fixed for its month. There is no surge.
- **Your driver.** The same verified driver every day, with backups you approve.
- **On-time Promise, measured by live location.** Lateness is the time between the booked pickup and the driver's recorded arrival, never less than any delay the driver reported. When lateness reaches `promise_minutes` (10 by default), the trip value goes back to the passenger as ride credit (an employer is simply not charged). A booked ride that never gets a driver is cancelled at pickup time and its fare credited. Go Rides carries the cost; the driver is still paid. How arrival is recorded (`src/location.js`):
  - Pickup addresses are not geocoded, so Go Rides learns each passenger's **pickup points**: from where the driver stood when they first tapped "I have arrived", or from the passenger's phone (*Your details > Pickup points*).
  - While a trip is under way the driver app sends its location every 10 seconds. Within 150 m of a known pickup point, the trip is marked **arrived automatically** and the passenger is told.
  - An "I have arrived" tap is **refused** when the driver's location (under 2 minutes old) is more than 500 m from the known pickup point.
  - Each booking run **warns passengers** once their driver is past the promise limit, and tells the operations team if the driver has not even set off.
- **Go Parcels: commuter-route logistics.** Drivers already cover the same routes every morning and evening. A parcel from Soweto to Sandton rides on a morning run carrying a Soweto passenger to work in Sandton, or on an evening run the other way. Senders pay a fixed price by size from their ride balance, or on the employer's invoice. The recipient gets a 4-digit code by SMS, and the driver must enter it to complete delivery. Each driver carries at most `parcel_capacity` parcels a day. If a parcel's run is cancelled it moves to another run, and if no run is found by its day it is refunded.
- **Earnings forecast.** Drivers see the trips and parcels already booked for the next 7 days, and earn extra from parcels on runs they already make.

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
- **Colours:** orange, green, black and white only, across the whole system: Go Ads orange `#ff4d00` (buttons, with black text), forest `#072014` and mint `#86ffb4`, plus tints and shades of those greens for lines, secondary text and light panels. Warnings and errors use orange. A browser audit of every page confirms nothing else is rendered (the OpenStreetMap trip map is the one outside element).
- **Look:** the "Go Pass", the commute as a monthly pass, with a dashed route line and numbered stops as the recurring motif. Comparisons on the site name "on-demand apps" rather than competitors, to stay within South Africa's advertising code on comparative claims.
- **Font:** Poppins throughout, self-hosted in `public/fonts/` under the SIL Open Font License.
- **Illustrations:** `public/illustrations/` holds flat SVG drawings in the four colours. Photographs of your own drivers and cars can replace any of them.

## Gift cards and partnerships

- **Gift cards** (`/gift-cards`): passengers and employers buy a card from R100 to R5,000 through the normal checkout. Once paid, the buyer sees a code such as `GO-7KQ4-M2XP`, and it is sent to the recipient by SMS and/or email. A passenger redeems it once into their ride balance; codes are forgiving about case and spacing, and repeated failed attempts are slowed down. Gift cards never expire, which meets the Consumer Protection Act's minimum of three years for prepaid vouchers. Admins see every card, the value not yet redeemed (owed as future rides), and can issue complimentary cards or cancel unused ones.
- **Partnerships** (`/partnerships`): corporate transport, fleet owners and drivers, retail and logistics, schools and campuses, and advertising with Go Ads. Applications (with a hidden anti-spam field and POPIA consent) are stored, admins are notified and the applicant gets a confirmation email; admins move each one through new, contacted, active or declined, with notes.

The footer's **Go Group** column links www.goads.co.za, www.gorides.co.za, Gift Cards and Partnerships, and the site is credited as managed and developed by [Digitalx](https://www.digitalxagency.io).

## The web app

Go Rides is an installable web app (a PWA), so there is nothing to publish to an app store:

- **Install:** Chrome and Edge show an **Install app** button; on iPhone, Safari's Share > Add to Home Screen. `/app` explains both, and phones see a dismissible install card.
- **App navigation:** signed-in passengers, drivers and employers get a bottom tab bar on phones, as in a native app.
- **Offline:** the service worker caches the app shell (styles, script, fonts, logo, illustrations) and shows an offline screen when there is no connection. Pages always load live, because ride details change.
- **Icons and shortcuts:** standard and maskable icons, and home-screen shortcuts to your Go Rides home and notifications.

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
