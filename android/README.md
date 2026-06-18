# Senior Directory — Android (Kotlin + Jetpack Compose)

The Android counterpart of the iOS app. Same backend, same `brands.json` contract, same
signed-payload security model — feature-for-feature parity:

- Minimalist **activation** screen (6-digit code) → fetch once → **offline** cache.
- **Directory grid** of 50 brand tiles + **local-only search** (no web requests).
- **3-second just-in-time safety prompt** before dialing; online-only brands show the
  no-phone-support warning instead.
- **Native dialer** via `ACTION_DIAL` (no call permission).
- **"Call My Person" panic button** (#2) and caregiver **pre-loaded contacts** (#15).
- **Ed25519 signature verification** of the activation payload (BouncyCastle), with a
  canonical string that matches the backend and iOS byte-for-byte.

## Build & run

Requires JDK 17 and the Android SDK (via Android Studio, or `sdkmanager`).

```bash
cd android
# Android Studio: open this folder and Run. Or from the CLI with a Gradle wrapper:
gradle :app:assembleDebug          # build the debug APK
gradle :app:testDebugUnitTest      # run unit tests (incl. signature conformance)
```

- **Debug** builds point at `http://10.0.2.2:8000` — the emulator's alias for your host
  machine's `localhost`, so they reach a backend running on your computer (mirrors the
  iOS localhost setup). **Release** points at the production HTTPS API.
- Cleartext HTTP is allowed only for `10.0.2.2`/`localhost` (see
  `res/xml/network_security_config.xml`); all other traffic must be HTTPS.

### Getting a code
Same as iOS: run the backend, mint a code, enter it in the app.

```bash
cd ../backend && uvicorn app.main:app --port 8000
curl -s -X POST 'http://localhost:8000/v1/dev/accounts?senior_display_name=Mom'
```

## The directory data
`app/src/main/assets/brands.json` is a copy of the canonical `data/brands.json` (the
single source of truth). CI re-syncs it on every build; after editing `data/brands.json`,
re-copy it: `cp ../data/brands.json app/src/main/assets/brands.json`.

## Structure
```
app/src/main/java/app/seniordirectory/
  Models.kt              data-contract models (kotlinx.serialization)
  AppState.kt            ViewModel: offline-first load, activation
  MainActivity.kt        Compose entry; phase router
  data/ApiClient.kt      thin OkHttp client (activation/refresh only)
  data/LocalCache.kt     SharedPreferences offline cache
  data/SeedData.kt       bundled brands.json loader
  security/SignatureVerifier.kt   Ed25519 + canonical string (matches backend/iOS)
  util/Dialer.kt         ACTION_DIAL
  ui/                    Compose screens + components + theme
```

> Note: this project is generated and compiled in CI (no Android toolchain in the dev
> sandbox). The CI `android` job runs `assembleDebug` + unit tests on every push.
