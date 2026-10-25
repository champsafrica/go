// Service zones used to match passengers with nearby drivers. Start with the areas you
// launch in and add more as the driver network grows.
export const ZONES = [
  'Johannesburg CBD', 'Soweto', 'Sandton', 'Randburg', 'Alexandra', 'Midrand', 'Tembisa', 'Kempton Park',
  'Germiston', 'Roodepoort', 'Pretoria CBD', 'Centurion', 'Mamelodi', 'Soshanguve',
  'Cape Town CBD', 'Bellville', 'Khayelitsha', 'Mitchells Plain',
  'Durban CBD', 'Umlazi', 'Pinetown'
];

export const CHANNELS = [['whatsapp', 'WhatsApp'], ['sms', 'SMS'], ['email', 'Email']];

export const COMPLAINT_CATEGORIES = ['Late pickup', 'Driver no-show', 'Driver behaviour', 'Vehicle condition', 'Safety concern', 'Billing', 'Other'];
