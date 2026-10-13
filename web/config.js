// Web funnel configuration. Override API_BASE for your environment.
window.APP_CONFIG = {
  // Backend API base URL.
  API_BASE: "http://localhost:8000",
  // Display prices (the source of truth for billing is Stripe; these are marketing copy).
  PRICES: {
    monthly: { label: "$4.99 / month", sub: "billed monthly" },
    yearly: { label: "$29.99 / year", sub: "save 50% — best value" },
  },
};
