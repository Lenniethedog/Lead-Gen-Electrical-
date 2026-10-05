/**
 * SYNTHETIC postcodes for local development and automated tests ONLY.
 *
 * The real source of truth is the ONS Postcode Directory (npm run postcodes:import). These rows
 * exist so the form works on a fresh checkout before that import has been run. The coordinates are
 * rough town-centre positions, and some of these postcodes may not exist in reality - which is
 * exactly why they must never reach staging or production (the seed script refuses to).
 */
export interface DevPostcode {
  postcode: string;
  lat: number;
  lng: number;
}

export const DEV_POSTCODES: readonly DevPostcode[] = [
  { postcode: "BR1 1AA", lat: 51.4056, lng: 0.0145 },
  { postcode: "BR2 0AA", lat: 51.3921, lng: 0.0224 },
  { postcode: "BR3 1AA", lat: 51.4088, lng: -0.0245 },
  { postcode: "BR4 0AA", lat: 51.3764, lng: -0.0123 },
  { postcode: "BR5 1AA", lat: 51.3918, lng: 0.1063 },
  { postcode: "BR6 0AA", lat: 51.3730, lng: 0.0997 },
  { postcode: "BR7 5AA", lat: 51.4141, lng: 0.0663 },
  { postcode: "BR8 7AA", lat: 51.3965, lng: 0.1706 },
  { postcode: "DA1 1AA", lat: 51.4462, lng: 0.2170 },
  { postcode: "DA11 0AA", lat: 51.4412, lng: 0.3622 },
  { postcode: "TN13 1AA", lat: 51.2724, lng: 0.1905 },
  { postcode: "TN14 5AA", lat: 51.3158, lng: 0.1785 },
];

/** Real, well-known postcodes OUTSIDE the footprint, for out-of-area tests. */
export const DEV_OUT_OF_AREA_POSTCODES: readonly DevPostcode[] = [
  { postcode: "SW1A 1AA", lat: 51.501, lng: -0.1416 },
  { postcode: "M1 1AE", lat: 53.4808, lng: -2.2426 },
];
