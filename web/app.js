// Landing-page logic: capture the influencer ref, start checkout.
(function () {
  const cfg = window.APP_CONFIG;

  // Reflect configured prices into the page.
  const p = cfg.PRICES;
  document.getElementById("price-monthly").textContent = p.monthly.label;
  document.getElementById("detail-monthly").textContent = p.monthly.sub;
  document.getElementById("price-yearly").textContent = p.yearly.label;
  document.getElementById("detail-yearly").textContent = p.yearly.sub;

  // Influencer/affiliate tracking: ?ref=NAME is captured and persisted so it survives
  // the click-through to checkout.
  const params = new URLSearchParams(location.search);
  const ref = params.get("ref");
  if (ref) sessionStorage.setItem("ref", ref);

  const errorEl = document.getElementById("checkout-error");

  async function startCheckout(plan) {
    errorEl.hidden = true;
    try {
      const res = await fetch(`${cfg.API_BASE}/v1/checkout/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, ref: sessionStorage.getItem("ref") }),
      });
      if (!res.ok) throw new Error(`Checkout failed (${res.status})`);
      const data = await res.json();
      window.location.href = data.checkout_url; // Stripe Checkout, or the simulated success page
    } catch (e) {
      errorEl.textContent = "Sorry, we couldn’t start checkout. Please try again.";
      errorEl.hidden = false;
      console.error(e);
    }
  }

  document.querySelectorAll("button[data-plan]").forEach((btn) => {
    btn.addEventListener("click", () => startCheckout(btn.dataset.plan));
  });
})();
