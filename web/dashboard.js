// Caregiver dashboard: sign in with the caregiver key, manage the senior's account.
(function () {
  const API = window.APP_CONFIG.API_BASE;
  const $ = (id) => document.getElementById(id);
  let apiKey = sessionStorage.getItem("cgk") || "";

  // --- API helper (X-API-Key auth) ---
  async function api(method, path, body) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        "X-API-Key": apiKey,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res;
  }

  // --- US phone normalization -> E.164 + display ---
  function normalizePhone(input) {
    let d = (input || "").replace(/\D/g, "");
    if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
    if (d.length !== 10) return null;
    return { e164: "+1" + d, display: `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` };
  }

  function show(id, on) { $(id).hidden = !on; }
  function setError(id, msg) { const e = $(id); e.textContent = msg || ""; e.hidden = !msg; }

  // --- Sign in ---
  async function signIn() {
    apiKey = $("apiKey").value.trim();
    setError("loginError", "");
    const res = await api("GET", "/v1/account");
    if (res.status === 401) { setError("loginError", "That key didn’t work. Please check it."); return; }
    if (!res.ok) { setError("loginError", "Something went wrong. Please try again."); return; }
    sessionStorage.setItem("cgk", apiKey);
    show("login", false);
    show("dashboard", true);
    show("logout", true);
    await Promise.all([loadAccount(), loadEmergency(), loadContacts()]);
  }

  function signOut() {
    sessionStorage.removeItem("cgk");
    location.reload();
  }

  // --- Account summary ---
  async function loadAccount() {
    const a = await (await api("GET", "/v1/account")).json();
    $("seniorName").value = a.senior_display_name;
    $("activationCode").textContent = a.activation_code;
    $("tierBadge").textContent = a.tier === "premium" ? "Premium" : "Free";
    $("tierBadge").className = "badge " + (a.tier === "premium" ? "badge-premium" : "");
    renderLimit(a);
  }

  function renderLimit(a) {
    const max = a.limits.max_custom_contacts;
    const used = a.custom_contacts_count;
    $("contactCount").textContent = max == null ? `${used} contacts` : `${used} of ${max} used`;
    const atLimit = max != null && used >= max;
    $("addContact").disabled = atLimit;
    if (atLimit) {
      $("limitNote").textContent = "You’ve reached the Free plan’s 3-contact limit. Premium allows unlimited contacts.";
      show("limitNote", true);
    } else {
      show("limitNote", false);
    }
  }

  async function saveName() {
    const name = $("seniorName").value.trim();
    if (!name) return;
    await api("PUT", "/v1/account", { senior_display_name: name });
  }

  // --- Emergency contact ---
  async function loadEmergency() {
    const res = await api("GET", "/v1/account/emergency-contact");
    const ec = res.ok ? await res.json() : null;
    $("emergencyCurrent").textContent = ec
      ? `Current: ${ec.name} (${ec.relationship}) — ${ec.phone_display}`
      : "No “Call My Person” contact set yet.";
    if (ec) {
      $("ecName").value = ec.name;
      $("ecRelationship").value = ec.relationship;
      $("ecPhone").value = ec.phone_display;
    }
  }

  async function saveEmergency() {
    setError("ecError", "");
    const phone = normalizePhone($("ecPhone").value);
    if (!$("ecName").value.trim()) return setError("ecError", "Please enter your name.");
    if (!phone) return setError("ecError", "Please enter a valid 10-digit US phone number.");
    const res = await api("PUT", "/v1/account/emergency-contact", {
      name: $("ecName").value.trim(),
      phone: phone.e164,
      phone_display: phone.display,
      relationship: $("ecRelationship").value.trim() || "contact",
      photo_url: null,
    });
    if (!res.ok) return setError("ecError", "Couldn’t save. Please try again.");
    await loadEmergency();
  }

  // --- Contacts ---
  async function loadContacts() {
    const contacts = await (await api("GET", "/v1/account/contacts")).json();
    const ul = $("contactsList");
    ul.innerHTML = "";
    for (const c of contacts) {
      const li = document.createElement("li");
      li.className = "contact-item";
      const info = document.createElement("div");
      info.innerHTML = `<strong>${escapeHtml(c.name)}</strong> · ${escapeHtml(c.category)}<br><span class="muted">${escapeHtml(c.phone_display)}${c.note ? " — " + escapeHtml(c.note) : ""}</span>`;
      const del = document.createElement("button");
      del.className = "btn btn-small btn-danger";
      del.textContent = "Remove";
      del.onclick = async () => { await api("DELETE", `/v1/account/contacts/${c.id}`); await refresh(); };
      li.append(info, del);
      ul.append(li);
    }
  }

  async function addContact() {
    setError("cError", "");
    const phone = normalizePhone($("cPhone").value);
    if (!$("cName").value.trim()) return setError("cError", "Please enter a name.");
    if (!phone) return setError("cError", "Please enter a valid 10-digit US phone number.");
    const res = await api("POST", "/v1/account/contacts", {
      name: $("cName").value.trim(),
      phone: phone.e164,
      phone_display: phone.display,
      category: $("cCategory").value.trim() || "Contact",
      note: $("cNote").value.trim() || null,
      photo_url: null,
    });
    if (res.status === 409) return setError("cError", "You’ve reached your contact limit.");
    if (!res.ok) return setError("cError", "Couldn’t add. Please try again.");
    for (const id of ["cName", "cCategory", "cPhone", "cNote"]) $(id).value = "";
    await refresh();
  }

  async function refresh() { await Promise.all([loadAccount(), loadContacts()]); }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // --- Wire up ---
  $("signIn").onclick = signIn;
  $("logout").onclick = signOut;
  $("saveName").onclick = saveName;
  $("saveEmergency").onclick = saveEmergency;
  $("addContact").onclick = addContact;
  $("apiKey").addEventListener("keydown", (e) => { if (e.key === "Enter") signIn(); });

  // Auto sign-in if a key is already stored this session.
  if (apiKey) { $("apiKey").value = apiKey; signIn(); }
})();
