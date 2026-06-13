"""Senior Directory backend (FastAPI).

Serves the hardcoded national-brand directory and issues signed, offline-cacheable
activation payloads for senior devices. Account creation is driven by Stripe webhooks
from the web checkout funnel — the mobile app never touches billing.
"""

__version__ = "1.0.0"
