// All amounts are in Rand. Prices are rounded to whole Rand so they are easy to read on
// a phone and in a WhatsApp message.

export function tripFare(distanceKm, s) {
  return Math.max(s.min_fare, Math.round(s.base_fare + s.per_km * distanceKm));
}

export function driverPayout(fare, s) {
  return round2(fare * (1 - s.commission_pct / 100));
}

export function planPrice(plan, distanceKm, s) {
  const fare = tripFare(distanceKm, s);
  return Math.round(fare * plan.trips_per_month * (1 - plan.discount_pct / 100));
}

// The value of one subscription trip, used to pay the driver for it.
export function subscriptionTripValue(sub) {
  return round2(sub.price / sub.trips_included);
}

export const RIDE_PACKS = [
  { rides: 10, discount_pct: 0 },
  { rides: 20, discount_pct: 5 },
  { rides: 40, discount_pct: 8 }
];

export function packPrice(pack, distanceKm, s) {
  return Math.round(tripFare(distanceKm, s) * pack.rides * (1 - pack.discount_pct / 100));
}

export function round2(n) {
  return Math.round(n * 100) / 100;
}

export function rand(n) {
  const v = Number(n) || 0;
  const sign = v < 0 ? '-' : '';
  return `${sign}R${Math.abs(v).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
