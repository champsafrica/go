// Progressive enhancements: everything works without JavaScript except live location.
document.addEventListener('click', e => {
  const confirmBtn = e.target.closest('[data-confirm]');
  if (confirmBtn && !confirm(confirmBtn.dataset.confirm)) e.preventDefault();

  const share = e.target.closest('[data-share]');
  if (share) {
    const url = share.dataset.share;
    if (navigator.share) navigator.share({ title: 'My Go Rides trip', text: 'Follow my ride live:', url }).catch(() => {});
    else navigator.clipboard?.writeText(url).then(() => { share.textContent = 'Copied'; });
  }
  if (e.target.closest('[data-print]')) window.print();
});

document.querySelectorAll('form[data-autosubmit]').forEach(f => f.submit());

// Attach the passenger's position to an SOS alert when the browser allows it.
document.querySelectorAll('form[data-geo]').forEach(form => {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(pos => {
    form.lat.value = pos.coords.latitude.toFixed(6);
    form.lng.value = pos.coords.longitude.toFixed(6);
  }, () => {}, { enableHighAccuracy: true, timeout: 10000 });
});

// Passenger and share pages: poll trip status and show the driver on a map.
const LABELS = { scheduled: 'Scheduled', unassigned: 'Finding driver', en_route: 'Driver on the way', arrived: 'Driver arrived',
  in_progress: 'On the road', completed: 'Completed', cancelled: 'Cancelled', no_show: 'No-show' };
document.querySelectorAll('[data-track]').forEach(box => {
  let lastKey = '';
  const update = async () => {
    try {
      const data = await fetch(box.dataset.track, { headers: { Accept: 'application/json' } }).then(r => r.json());
      const status = box.querySelector('[data-field=status]');
      if (status) status.innerHTML = `<span class="pill pill-${data.status}">${LABELS[data.status] ?? data.status}</span>` +
        (data.delay_minutes ? ` <span class="pill pill-late">${data.delay_minutes} min late</span>` : '');
      const map = box.querySelector('[data-field=map]');
      const updated = box.querySelector('[data-field=updated]');
      if (map && data.location) {
        const { lat, lng, at } = data.location;
        const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
        if (key !== lastKey) {
          const d = 0.01;
          map.innerHTML = `<iframe title="Driver location" loading="lazy" src="https://www.openstreetmap.org/export/embed.html?bbox=${lng - d},${lat - d},${lng + d},${lat + d}&layer=mapnik&marker=${lat},${lng}"></iframe>`;
          lastKey = key;
        }
        if (updated) updated.textContent = `Driver location updated ${at} UTC`;
      } else if (updated) {
        updated.textContent = ['scheduled', 'unassigned'].includes(data.status) ? 'The map appears once your driver starts the trip.' : '';
      }
      if (['completed', 'cancelled', 'no_show'].includes(data.status)) return;
    } catch {}
    setTimeout(update, 15000);
  };
  update();
});

// Driver dashboard: share location while a trip is under way.
const loc = document.querySelector('[data-location=on]');
if (loc && navigator.geolocation) {
  const label = loc.querySelector('[data-field=loc-status]');
  let last = 0;
  navigator.geolocation.watchPosition(pos => {
    if (Date.now() - last < 10000) return;
    last = Date.now();
    fetch(loc.dataset.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': loc.dataset.csrf },
      body: JSON.stringify({ lat: pos.coords.latitude, lng: pos.coords.longitude })
    }).then(() => { label.textContent = `Sharing live location (updated ${new Date().toLocaleTimeString('en-ZA')}).`; });
  }, () => { label.textContent = 'Allow location access so your passenger can see where you are.'; }, { enableHighAccuracy: true });
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
