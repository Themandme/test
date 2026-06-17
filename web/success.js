// Success page: poll the backend until the account is provisioned, then show the code.
(function () {
  const cfg = window.APP_CONFIG;
  const sessionId = new URLSearchParams(location.search).get("session_id");

  const show = (id) => {
    for (const s of ["loading", "ready", "error"]) {
      document.getElementById(s).hidden = s !== id;
    }
  };

  if (!sessionId) {
    show("error");
    return;
  }

  let attempts = 0;
  const MAX_ATTEMPTS = 20; // ~20s of polling for the webhook to land

  async function poll() {
    attempts += 1;
    try {
      const res = await fetch(
        `${cfg.API_BASE}/v1/checkout/result?session_id=${encodeURIComponent(sessionId)}`
      );
      if (res.ok) {
        const data = await res.json();
        if (data.status === "ready") {
          document.getElementById("code").textContent = data.activation_code;
          show("ready");
          return;
        }
      }
    } catch (e) {
      console.error(e);
    }
    if (attempts >= MAX_ATTEMPTS) {
      show("error");
    } else {
      setTimeout(poll, 1000);
    }
  }

  poll();
})();
