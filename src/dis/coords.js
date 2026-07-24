// WGS84 geocentric (ECEF) <-> geodetic conversions.
// DIS Entity Location is expressed in earth-centred, earth-fixed metres.

const A = 6378137.0;            // WGS84 semi-major axis (m)
const F = 1 / 298.257223563;   // flattening
const B = A * (1 - F);         // semi-minor axis
const E2 = F * (2 - F);        // first eccentricity squared
const EP2 = (A * A - B * B) / (B * B); // second eccentricity squared

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

// ECEF metres -> { lat, lon (degrees), alt (m) }.
// Uses the closed-form Bowring method (accurate, no iteration needed for most cases).
export function ecefToGeodetic(x, y, z) {
  const p = Math.sqrt(x * x + y * y);
  if (p < 1e-9) {
    // On the polar axis.
    const lat = z >= 0 ? 90 : -90;
    const alt = Math.abs(z) - B;
    return { lat, lon: 0, alt };
  }
  const theta = Math.atan2(z * A, p * B);
  const sinT = Math.sin(theta);
  const cosT = Math.cos(theta);
  const lat = Math.atan2(
    z + EP2 * B * sinT * sinT * sinT,
    p - E2 * A * cosT * cosT * cosT
  );
  const lon = Math.atan2(y, x);
  const sinLat = Math.sin(lat);
  const N = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  const alt = p / Math.cos(lat) - N;
  return { lat: lat * RAD2DEG, lon: lon * RAD2DEG, alt };
}

// { lat, lon (degrees), alt (m) } -> ECEF metres.
export function geodeticToEcef(lat, lon, alt) {
  const latR = lat * DEG2RAD;
  const lonR = lon * DEG2RAD;
  const sinLat = Math.sin(latR);
  const cosLat = Math.cos(latR);
  const N = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  const x = (N + alt) * cosLat * Math.cos(lonR);
  const y = (N + alt) * cosLat * Math.sin(lonR);
  const z = (N * (1 - E2) + alt) * sinLat;
  return { x, y, z };
}
