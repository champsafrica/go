import { html } from '../views/html.js';
import { layout } from '../views/layout.js';
import { getSettings } from '../db.js';
import { rand, tripFare } from '../pricing.js';
import { ARRIVAL_RADIUS_M, ARRIVAL_TAP_LIMIT_M } from '../location.js';
import { MIN_AMOUNT, MAX_AMOUNT } from '../giftcards.js';

// "How it works": the whole system from A to Z, using the live settings so the numbers
// on the page always match what the system does.
export default function guideRoutes(app, db) {
  app.get('/how-it-works', async (req, res) => {
    const s = await getSettings(db);
    const plans = await db.prepare('SELECT * FROM plans WHERE active = 1 ORDER BY trips_per_month DESC').all();
    const sections = [
      ['start', 'Go Rides in one minute'], ['passengers', 'Passengers'], ['booking', 'How rides are booked'], ['ride-day', 'The day of your ride'],
      ['promise', 'The On-time Promise'], ['sharing', 'Shared rides'], ['paying', 'Paying'], ['parcels', 'Go Parcels'], ['drivers', 'Drivers'],
      ['employers', 'Employers'], ['gift-cards', 'Gift cards'], ['partners', 'Partnerships'], ['operations', 'Behind the scenes'],
      ['safety', 'Safety and privacy'], ['app', 'The app'], ['faq', 'Questions']
    ];
    const sec = (id, n, title, body) => html`<section class="guide-sec" id="${id}"><p class="stop"><span>${String(n).padStart(2, '0')}</span>${title}</p>${body}</section>`;
    res.send(String(layout(req, { title: 'How it works', wide: true, body: html`
      <div class="guide">
        <nav class="guide-toc" aria-label="On this page"><strong>On this page</strong>
          <ol>${sections.map(([id, t]) => html`<li><a href="#${id}">${t}</a></li>`)}</ol></nav>
        <article class="guide-body">
          <h1>How Go Rides works, from A to Z</h1>
          <p class="lede">Everything the system does for passengers, drivers, employers and parcel senders, step by step.</p>

          ${sec('start', 1, 'Go Rides in one minute', html`
            <p>Go Rides is planned transport. Instead of requesting a ride every morning, you tell Go Rides your route and the days and times you travel, once. Every week the system books your rides ${s.booking_horizon_days} days ahead with a driver you chose, for a monthly price that does not change.</p>
            <p>Because every trip is planned, Go Rides can promise things on-demand apps cannot: the same driver every day, a locked price, ride credit when a driver is late, cheaper shared rides with neighbours, and parcels carried on the same routes.</p>`)}

          ${sec('passengers', 2, 'Passengers: getting set up', html`
            <ol class="guide-steps">
              <li><strong>Create your account.</strong> Sign up with your name, mobile number, home and work addresses, your home and work areas, and the one-way distance. Add an emergency contact, and choose how we contact you: WhatsApp, SMS or email.</li>
              <li><strong>Decide whether to share.</strong> Sharing your rides takes ${s.shared_discount_pct}% off every price. You can switch it on or off at any time.</li>
              <li><strong>Set your weekly schedule.</strong> Choose your days and your pickup times from home and from work. You can have more than one schedule, for example different times on Fridays.</li>
              <li><strong>Choose your driver.</strong> Pick a verified driver from your area as your regular driver, and add backups you are happy to ride with.</li>
              <li><strong>Pay.</strong> Buy a Go Pass (a monthly plan) or a ride pack, or have your employer pay. Rides are booked once your payment is in place.</li>
              <li><strong>Set your pickup points.</strong> Under Your details, stand where you wait and tap "I am at my home pickup point" (and the same at work). Drivers' live location then records exactly when they arrive.</li>
            </ol>`)}

          ${sec('booking', 3, 'How rides are booked', html`
            <p>Every 5 minutes, and whenever something changes, the booking engine works through every active schedule:</p>
            <ol class="guide-steps">
              <li>It books each ride for the next ${s.booking_horizon_days} days that is not booked yet, but only if it is paid for: by an active Go Pass, your employer, or enough ride balance for the rides already booked.</li>
              <li>It picks a driver in this order: your regular driver; for a shared ride, a driver already carrying neighbours on your route with a free seat; your approved backups; the best-rated, least-busy verified driver in your area; then any verified driver.</li>
              <li>A driver is only chosen if they are approved, available at that time, not on time off, and free of other trips within an hour (or, for shared rides, carrying matching passengers within ${s.pool_window_minutes} minutes and with a seat free).</li>
              <li>If nobody is free, the ride shows "Finding driver", the operations team is alerted, and every booking run tries again.</li>
              <li>If your driver books time off or is suspended, their rides move to backups and you get one message telling you who is coming instead.</li>
            </ol>`)}

          ${sec('ride-day', 4, 'The day of your ride', html`
            <ol class="guide-steps">
              <li><strong>Reminder.</strong> About ${s.reminder_minutes} minutes before pickup you get your driver's name, car and registration.</li>
              <li><strong>On the way.</strong> When your driver starts the trip, you are notified and can follow their live location on the trip page.</li>
              <li><strong>Arrival.</strong> When the driver comes within ${ARRIVAL_RADIUS_M} m of your pickup point, live location records their arrival automatically and tells you. A driver cannot tap "I have arrived" while their location shows them more than ${ARRIVAL_TAP_LIMIT_M} m away.</li>
              <li><strong>Running late.</strong> If your driver has not reached you ${s.promise_minutes} minutes after your pickup time, you are told, and the ride is covered by the On-time Promise.</li>
              <li><strong>Safety.</strong> Share a live trip link with family, call your driver, or press SOS to alert our team and your emergency contact.</li>
              <li><strong>Afterwards.</strong> The ride is charged to your Go Pass, your employer or your ride balance, and you can rate your driver or report a problem.</li>
            </ol>`)}

          ${sec('promise', 5, 'The On-time Promise', html`
            <p>If your driver arrives ${s.promise_minutes} minutes or more after your booked pickup time, the ride comes back to you as ride credit. Your employer is not charged if they pay for your rides.</p>
            <p>Lateness is measured, not taken on trust: it is the time between your pickup time and the driver's recorded arrival, from live location or from their arrival tap at your pickup point. If the driver reported a longer delay themselves, that counts instead.</p>
            <p>If we cannot find a driver for a booked ride at all, the ride is cancelled at its pickup time and its full fare is added to your balance. Go Rides pays for the promise; drivers are still paid for the trip.</p>`)}

          ${sec('sharing', 6, 'Shared rides', html`
            <p>Passengers who share pay ${s.shared_discount_pct}% less. Two sharers ride in the same car when they live in the same area, work in the same area, travel the same way on the same day, and have pickups no more than ${s.pool_window_minutes} minutes apart, and only while the car has a free seat. People who do not share never get a shared car.</p>
            <p>You pay the shared price even on days when nobody joins you. You see the first names and pickup times of the people you ride with; your driver sees the pickup order.</p>`)}

          ${sec('paying', 7, 'Paying', html`
            <ul class="ticks">
              <li><strong>Go Pass (monthly plans):</strong> ${plans.map(p => `${p.name}, ${p.trips_per_month} trips (${p.discount_pct}% off)`).join('; ')}. The price is locked for the month; turn auto-renew on or off at any time.</li>
              <li><strong>Ride packs:</strong> 10, 20 or 40 rides of credit in your ride balance, for rides outside a plan.</li>
              <li><strong>Pay as you go:</strong> from ${rand(s.min_fare)} a trip; a 15 km trip costs ${rand(tripFare(15, s))}, or ${rand(tripFare(15, s, true))} shared.</li>
              <li><strong>Employer:</strong> sponsored employees ride on their company's monthly invoice.</li>
              <li><strong>Gift cards:</strong> redeem a code to add credit to your ride balance.</li>
            </ul>
            <p>Card and EFT payments go through PayFast. Your ride balance pays for rides beyond your plan, pay-as-you-go rides and parcels.</p>`)}

          ${sec('parcels', 8, 'Go Parcels', html`
            <ol class="guide-steps">
              <li><strong>Book.</strong> Under Parcels, choose the areas the parcel travels between, the day, the size and the recipient. Prices are fixed: small ${rand(s.parcel_small)}, medium ${rand(s.parcel_medium)}, large ${rand(s.parcel_large)}. It is paid from your ride balance, or your company's invoice.</li>
              <li><strong>Matching.</strong> The parcel is put on a driver's scheduled run on that route: a morning run for parcels going towards work areas, an evening run for the way back. Each driver carries at most ${s.parcel_capacity} parcels a day.</li>
              <li><strong>Hand-over.</strong> The recipient gets a 4-digit code by SMS. The driver collects the parcel, and can only mark it delivered by entering that code.</li>
              <li><strong>Tracking.</strong> Sender and recipient follow it with a tracking link (which never shows the code).</li>
              <li><strong>If plans change.</strong> If the run is cancelled, the parcel moves to another run. If no run is found by its day, or you cancel before collection, you get a full refund.</li>
            </ol>`)}

          ${sec('drivers', 9, 'Drivers', html`
            <ol class="guide-steps">
              <li><strong>Apply.</strong> Register with your vehicle, registration, ID, driver's licence and PrDP. Our team checks them, and a criminal record check, before your first trip.</li>
              <li><strong>Set your hours.</strong> Choose the days and times you drive. Book time off and your trips move to backup drivers automatically.</li>
              <li><strong>Drive.</strong> Today shows your pickups in order. Tap "Start: on my way", "Passenger picked up" and "Trip complete"; your arrival is recorded by live location. Report a delay if you are running late, and the passenger is told.</li>
              <li><strong>Shared cars and parcels.</strong> Shared runs show the pickup order. Parcels on your runs show where to collect and deliver; enter the recipient's code to complete a delivery.</li>
              <li><strong>Earnings.</strong> You keep ${100 - s.commission_pct}% of every fare and parcel price, and see the trips and parcels already booked for the next 7 days.</li>
            </ol>`)}

          ${sec('employers', 10, 'Employers', html`
            <ol class="guide-steps">
              <li>Open a business account, then add employees by the email of their Go Rides account. Their rides are then billed to you.</li>
              <li>Employees set their own schedules; they can share to cut costs.</li>
              <li>Send documents and stock between sites with Go Parcels, on the same invoice.</li>
              <li>The monthly report lists every employee's rides, late pickups and cost. Late pickups credited under the On-time Promise are not charged.</li>
            </ol>`)}

          ${sec('gift-cards', 11, 'Gift cards', html`
            <p>Buy a gift card from ${rand(MIN_AMOUNT)} to ${rand(MAX_AMOUNT)} under <a href="/gift-cards">Gift cards</a>. Once it is paid, you get a code like GO-7KQ4-M2XP, and we send it to the recipient by SMS or email if you gave their details. They redeem it once into their ride balance. Gift cards never expire.</p>`)}

          ${sec('partners', 12, 'Partnerships', html`
            <p>Companies, fleet owners, retailers, schools and advertisers can apply on the <a href="/partnerships">Partnerships</a> page. Applications go to the Go Rides team, who contact applicants within two working days and track each one from new to active.</p>`)}

          ${sec('operations', 13, 'Behind the scenes', html`
            <ul class="ticks">
              <li><strong>Driver verification:</strong> the operations team approves or suspends drivers. Suspended drivers' trips go back for reassignment.</li>
              <li><strong>Dispatch:</strong> trips without a driver are flagged, and the team can assign or cancel any trip.</li>
              <li><strong>Support:</strong> complaints and SOS alerts arrive in one place, with the passenger, driver and location.</li>
              <li><strong>Pricing:</strong> fares, plan discounts, the sharing discount, the promise limit and parcel prices are all set by the team, and apply to new bookings.</li>
              <li><strong>Analytics:</strong> trips, on-time rate, shared rides, promise credits, parcels and demand by area, to show where to recruit drivers next.</li>
              <li><strong>Gift cards and partners:</strong> every card sold or issued, and every partnership application.</li>
            </ul>`)}

          ${sec('safety', 14, 'Safety and privacy', html`
            <ul class="ticks">
              <li>Every driver is ID, licence and PrDP checked; passengers ride with the same people every day.</li>
              <li>Live trip links let family follow a ride; SOS reaches our team and your emergency contact.</li>
              <li>Drivers' location is shared only while a trip is under way. Your pickup points are used only to record arrivals.</li>
              <li>Personal information is handled under POPIA, and only for running the service.</li>
            </ul>`)}

          ${sec('app', 15, 'The app', html`
            <p>Go Rides installs on your phone from the browser: on Android, tap Install; on iPhone, Share then Add to Home Screen. It opens like an app, with bottom navigation, and shows an offline screen when you have no connection. <a href="/app">Get the app</a>.</p>`)}

          ${sec('faq', 16, 'Questions', html`
            <dl class="faq">
              <dt>What if my driver cannot make it?</dt><dd>One of your backups, or another verified driver near you, is assigned, and you are told who is coming.</dd>
              <dt>Can I skip a day?</dt><dd>Yes. Cancel that ride under Trips; it is not charged.</dd>
              <dt>What happens at the end of the month?</dt><dd>With auto-renew on, a new Go Pass is ready to pay a few days before the old one ends, and we remind you.</dd>
              <dt>Does surge pricing ever apply?</dt><dd>No. A Go Pass price is fixed for its month, and fares only change for new bookings when Go Rides changes its prices.</dd>
              <dt>Who pays when the On-time Promise applies?</dt><dd>Go Rides. Drivers are still paid for the trip.</dd>
            </dl>`)}

          <div class="final-cta" style="margin-top:40px"><h2>Ready to go?</h2><p>Set up your commute in a few minutes.</p>
            <div class="cta-row"><a class="btn btn-go" href="/register?as=passenger">Get a Go Pass</a><a class="btn btn-line-light" href="/register?as=driver">Drive with us</a></div></div>
        </article>
      </div>` })));
  });
}
