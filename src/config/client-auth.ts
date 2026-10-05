/** How long a business's people stay signed in, and how much sign-in email we are willing to send. Decisions D43. */
export const CLIENT_AUTH = {
  /** A sign-in link works once, for this long. */
  linkTtlMinutes: 15,
  /** A session ends after this long without a request... */
  sessionIdleHours: 12,
  /** ...or this long after sign-in, whatever happens in between. */
  sessionAbsoluteDays: 14,
  /** At most this many links per person per hour (counted in the database, so it holds across several web instances). */
  maxLinksPerHour: 5,
  /** `last_seen_at` is written at most this often, so reading a page does not write a row every time. */
  touchEveryMinutes: 5,
} as const;

export const CLIENT_USER_ROLES = ["owner", "manager", "agent"] as const;
export type ClientUserRole = (typeof CLIENT_USER_ROLES)[number];

export const CLIENT_USER_ROLE_LABELS: Record<ClientUserRole, string> = {
  owner: "Owner (everything, including billing)",
  manager: "Manager (leads and settings)",
  agent: "Agent (leads only)",
};

/** A business in one of these states can sign in. A suspended or former business cannot, and its open sessions stop working at once. */
export const CLIENT_STATUSES_THAT_CAN_SIGN_IN = ["active", "paused"] as const;
