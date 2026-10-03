// Airlines we know a little more about than the aircraft databases say: a
// short name for the map, the two-letter code passengers see on their tickets
// (WestJet's callsign is WJA347 but the flight is WS347), and the brand colour
// used for its planes and trails on the map. Regional airlines that fly under
// a bigger brand (WestJet Encore, Air Canada Jazz and Rouge) use that brand's
// name, code and colour, since that's what's painted on the plane and printed
// on the ticket. Airlines not listed here still get their code from adsbdb and
// a steady colour of their own.
//
// icao: { name, iata, color }, or { name, brand: icao of the brand it flies for }
export const AIRLINES = {
  // Canada
  ACA: { name: 'Air Canada', iata: 'AC', color: '#f01428' },
  JZA: { name: 'Air Canada Express', brand: 'ACA' }, // flown by Jazz
  ROU: { name: 'Air Canada Rouge', brand: 'ACA' },
  WJA: { name: 'WestJet', iata: 'WS', color: '#00aaa5' },
  WEN: { name: 'WestJet Encore', brand: 'WJA' },
  SWG: { name: 'Sunwing', iata: 'WG', color: '#f7901e' },
  POE: { name: 'Porter', iata: 'PD', color: '#1b2f5b' },
  FLE: { name: 'Flair', iata: 'F8', color: '#8cc63f' },
  TSC: { name: 'Air Transat', iata: 'TS', color: '#1f9ad6' },
  // United States
  DAL: { name: 'Delta', iata: 'DL', color: '#0b2a5b' },
  UAL: { name: 'United', iata: 'UA', color: '#005daa' },
  AAL: { name: 'American', iata: 'AA', color: '#0078d2' },
  ASA: { name: 'Alaska', iata: 'AS', color: '#01426a' },
  SWA: { name: 'Southwest', iata: 'WN', color: '#304cb2' },
  JBU: { name: 'JetBlue', iata: 'B6', color: '#0033a0' },
  FFT: { name: 'Frontier', iata: 'F9', color: '#00843d' },
  NKS: { name: 'Spirit', iata: 'NK', color: '#ffec00' },
  HAL: { name: 'Hawaiian', iata: 'HA', color: '#6a2c91' },
  SCX: { name: 'Sun Country', iata: 'SY', color: '#f26722' },
  FDX: { name: 'FedEx', iata: 'FX', color: '#4d148c' },
  UPS: { name: 'UPS', iata: '5X', color: '#ffb500' },
  // Europe, Asia and beyond
  KLM: { name: 'KLM', iata: 'KL', color: '#00a1de' },
  AFR: { name: 'Air France', iata: 'AF', color: '#002157' },
  BAW: { name: 'British Airways', iata: 'BA', color: '#075aaa' },
  DLH: { name: 'Lufthansa', iata: 'LH', color: '#05164d' },
  SWR: { name: 'Swiss', iata: 'LX', color: '#e2001a' },
  EIN: { name: 'Aer Lingus', iata: 'EI', color: '#006272' },
  FIN: { name: 'Finnair', iata: 'AY', color: '#0b1560' },
  ICE: { name: 'Icelandair', iata: 'FI', color: '#002e6d' },
  VIR: { name: 'Virgin Atlantic', iata: 'VS', color: '#da0530' },
  THY: { name: 'Turkish Airlines', iata: 'TK', color: '#c70a0c' },
  UAE: { name: 'Emirates', iata: 'EK', color: '#d71921' },
  QTR: { name: 'Qatar Airways', iata: 'QR', color: '#5c0632' },
  ETD: { name: 'Etihad', iata: 'EY', color: '#bd8b13' },
  CPA: { name: 'Cathay Pacific', iata: 'CX', color: '#006564' },
  ANA: { name: 'ANA', iata: 'NH', color: '#133c8b' },
  JAL: { name: 'Japan Airlines', iata: 'JL', color: '#cc0000' },
  KAL: { name: 'Korean Air', iata: 'KE', color: '#4fa3dd' },
  AAR: { name: 'Asiana', iata: 'OZ', color: '#a28754' },
  CCA: { name: 'Air China', iata: 'CA', color: '#e30613' },
  CAO: { name: 'Air China Cargo', iata: 'CA', color: '#e30613' },
  CES: { name: 'China Eastern', iata: 'MU', color: '#1d4f91' },
  CSN: { name: 'China Southern', iata: 'CZ', color: '#0b6cb5' },
  EVA: { name: 'EVA Air', iata: 'BR', color: '#00704a' },
  QFA: { name: 'Qantas', iata: 'QF', color: '#e40000' },
  AMX: { name: 'Aeroméxico', iata: 'AM', color: '#0b2343' },
};

/**
 * What we know about an airline: its own name, the flight code it sells
 * under, and the brand it flies as ({ icao, name, color }); null if it's not listed.
 */
export function knownAirline(icao) {
  const own = AIRLINES[icao];
  const brandIcao = own?.brand ?? icao;
  const brand = AIRLINES[brandIcao];
  if (!own || !brand) return null;
  return {
    name: own.name ?? brand.name,
    iata: own.iata ?? brand.iata,
    brand: { icao: brandIcao, name: brand.name, color: brand.color },
  };
}

/** The ICAO airline code at the start of a callsign: "WJA347" → "WJA". */
export const callsignAirline = (callsign) => /^([A-Z]{3})\d/.exec(callsign ?? '')?.[1] ?? null;

/**
 * The flight number passengers see: "WJA347" with code "WS" → "WS347".
 * Only callsigns that are an airline code plus a plain number map onto a
 * flight number; ones like "ASA12B" are the airline's own radio shorthand.
 */
export function flightCode(callsign, iata) {
  const m = /^[A-Z]{3}0*(\d{1,4})$/.exec(callsign ?? '');
  return m && iata ? `${iata}${m[1]}` : null;
}
