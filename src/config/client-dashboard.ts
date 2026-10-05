/** What a business sees for each state of a lead it was given. Their words, not the database's. */
export const CLIENT_STATUS_LABELS: Record<"reserved" | "notified" | "accepted" | "disputed" | "rejected" | "refunded" | "expired" | "cancelled" | "delivery_failed", string> = {
  reserved: "New",
  notified: "New",
  accepted: "Accepted",
  disputed: "Disputed",
  rejected: "Declined",
  refunded: "Refunded",
  expired: "Expired",
  cancelled: "Taken back",
  delivery_failed: "Not delivered",
};

/** The states in which a business HOLDS the lead (and so may see the person's details): it is theirs alone and still open. */
export const HELD_STATUSES = ["reserved", "notified", "accepted", "disputed"] as const;

export const DASHBOARD_PAGE_SIZE = 200;
