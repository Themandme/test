# Store Submission Guide (App Store + Google Play)

Everything needed to submit both apps, including the exact privacy-form answers and the
review notes that defend the web-checkout model.

## The one rule that matters
The binaries contain **zero purchase, pricing, or upgrade language** — enforced by CI
(`scripts/check_store_compliance.py`, the `store-compliance` job). Never add copy like
"upgrade for more contacts." The free-tier cap must always read as a neutral "list
full." All monetization copy lives on the web only.

## Apple App Store

**Review notes (paste into App Review Information):**
> Safe Numbers is a companion utility for accounts created on our website. Family
> caregivers subscribe and create accounts on the web; the senior's app only accepts a
> 6-digit activation code, per guideline 3.1.3(b) (multiplatform services). The app
> contains no purchases, no pricing, and no links to external purchase flows.
>
> **Demo for review:** use activation code [CREATE A LIVE DEMO ACCOUNT AND PUT ITS CODE
> HERE — keep it active for the whole review window].

**Privacy nutrition label (App Privacy section):**
| Question | Answer |
|---|---|
| Contact Info | **Not collected** by the app. (Caregiver email is collected on the web, not in-app.) |
| Contacts | **Not collected** — the app never reads the device address book. Caregiver-entered contacts are app functionality data, entered on the web. |
| Identifiers / Usage Data / Diagnostics | **Not collected** — no analytics or tracking SDKs. |
| Location / Health / Financial | Not collected. |
| Tracking (ATT) | **No tracking.** No IDFA use → no ATT prompt needed. |
| Data linked to user | Name + phone numbers of caregiver-chosen contacts, linked to the account (functionality only). |

Other checklist: age rating 4+; category *Utilities* (or *Lifestyle*); `ITSAppUsesNonExemptEncryption = NO`
(standard HTTPS/signature verification only — exempt); screenshots of directory, safety
prompt, activation; support URL + privacy URL live.

## Google Play

**Data safety form:**
| Question | Answer |
|---|---|
| Does your app collect or share user data? | **Collects** (contacts entered by the caregiver, delivered to the app), **no sharing** with third parties. |
| Data types | Personal info → Name, Phone number (the caregiver-entered contacts). Nothing else. |
| Purpose | App functionality only. Not used for ads/analytics. Not sold. |
| Encrypted in transit? | Yes. |
| Deletion mechanism? | Yes — email support (see privacy policy). |
| Location, App activity, Device IDs | Not collected. |

Other checklist: content rating *Everyone*; target API level current (34+ already); app
category *Tools*; the `ACTION_DIAL` intent needs **no** call permission (already true);
`allowBackup=false` already set. Play's "Financial features" declaration: **none** (no
in-app payments).

## Assets still needed (design work, not code)
- [ ] App icon (iOS asset catalog + Play 512×512) — current Android adaptive icon is a
      placeholder phone glyph; ship a real mark.
- [ ] Screenshots: 6.7"/6.1" iPhone, 13" iPad (if kept), Play phone + 7"/10" tablet.
- [ ] Feature graphic (Play, 1024×500).
- [ ] Store descriptions (short + full). Draft angle: "The safe way for seniors to call
      customer service. Real numbers, zero scams." **Never claim "verified" until the
      human number sign-off is complete — say "curated" or "spoof-resistant."**

## Known review risks & answers
- *"How do users get an account?"* → Web sign-up; app is login-only (3.1.3(b), the
  Netflix/Spotify pattern). Do not add any link to the website inside the app.
- *"Why these brand names?"* → Nominative fair use: text-only identification of the
  companies whose official numbers are listed; no logos; disclaimer in the listing and
  on the web. (Have counsel confirm the disclaimer wording.)
- *Play "impersonation" flag* → same answer; the app identifies brands to *protect*
  users, and the store listing must make that framing obvious.
