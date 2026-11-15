# DRAW2CODE AI  ·  automatic versions (see section 10)

Image → working website generator. Upload a screenshot or sketch, get HTML/CSS/JS (Bootstrap, vanilla or React), preview it, edit it, download a ZIP.
Projects live in **Firebase (Auth + Firestore)** under the user's account, with a local cache, so the same link shows the same data on any device.

No build step. Vercel serves the static files and serverless functions in `/api`.

**What's new in v2:** Pro Tools (Business ROI and BIR tax estimator), multi-page layout (`#/home`, `#/studio`, `#/projects`, `#/pricing`, `#/debug`, `#/login`, `#/account`, `#/changelog`), Login page with Google, AI Debugger, Pro plan paid via GCash (PayMongo), ROI calculator, live preview error detection, and an automatic "new version available" banner.

## 0. Quick start for project `raw2code`

The Firebase web config of `raw2code` is built in (`FIREBASE_DEFAULTS` in `api/_admin.js`), so the `FIREBASE_*` variables below are optional. You must add `GEMINI_API_KEY`, plus `PAYMONGO_SECRET_KEY` and `PAYMONGO_WEBHOOK_SECRET`, in Vercel; enable Google + Email/Password sign-in, publish `firestore.rules` (required: the server works through these rules), and add your Vercel domain under Authentication → Authorized domains.

## 1. Firebase setup (one time)

1. Firebase Console → create a project → add a **Web app** (`</>`). Copy `apiKey`, `authDomain`, `projectId`, `appId`, `messagingSenderId`.
2. **Authentication → Sign-in method**: enable **Email/Password** and **Google**.
3. **Firestore Database → Create database** (production mode), then **Rules** → paste `firestore.rules` → Publish.
4. After the first deploy: **Authentication → Settings → Authorized domains** → add your Vercel domain (e.g. `your-app.vercel.app`).

Storage is not needed: the source image is compressed and stored in Firestore.

## 2. Deploy to Vercel

1. Push this folder to GitHub (or run `vercel` from the folder).
2. Import it in Vercel. Framework Preset: **Other**. No build command, no output directory.
3. **Settings → Environment Variables** (Production + Preview):

| Name | Value |
| --- | --- |
| `FIREBASE_API_KEY` | Firebase web `apiKey` |
| `FIREBASE_AUTH_DOMAIN` | e.g. `your-project.firebaseapp.com` |
| `FIREBASE_PROJECT_ID` | Firebase project id |
| `FIREBASE_APP_ID` | Firebase web `appId` |
| `FIREBASE_MESSAGING_SENDER_ID` | optional |
| AI key | `GEMINI_API_KEY` (Google Gemini). Server-side only. `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are not used for AI requests. |
| `AI_PROVIDER` | Ignored; the app always uses Gemini. |

For local development, `api/_ai.js` loads the root `.env` automatically on supported Node.js versions; `.env` stays local and must not be committed. Vercel production does not load your computer's `.env`, so set `GEMINI_API_KEY` in Vercel Environment Variables and redeploy.

Optional Gemini model overrides: `GEMINI_MODEL_LOW|STANDARD|HIGH` or `GEMINI_MODEL`. Low uses the faster `gemini-3.5-flash-lite`; Standard and High use `gemini-3.8-flash`. If a model is unavailable, the server tries current Gemini fallback models. Optional too: `GEMINI_THINKING_LEVEL`, `RATE_LIMIT_PER_HOUR` (default `20` generations per user), and `MAX_OUTPUT_TOKENS` (default `16000`).

4. Redeploy after saving the variables.

If something is missing, the Studio section shows exactly which variable to add.

## Notes

- Generation streams for up to a couple of minutes. Vercel **Fluid Compute** (default on new projects) allows this. If your project has it off, enable it under Settings → Functions.
- `/api/generate` verifies the Firebase ID token on every request, so only signed-in users can spend your AI credits. Lower `RATE_LIMIT_PER_HOUR` to control cost.
- The preview runs in a sandboxed iframe, so generated code can never touch the user's session.
- Files: `index.html`, `version.json`, `assets/{app.js,extras.js,lib.js,style.css,pages.css,favicon.svg}`, `api/{config,generate,debug,checkout,billing,paymongo-webhook,_admin}.js`, `firestore.rules`, `vercel.json`.


## 3. Pro plan + GCash payments (PayMongo)

GCash cannot be charged directly from a website without a payment gateway, so Pro uses **PayMongo Checkout** (GCash is one of its payment methods). Real money goes to your PayMongo account.

1. Create a PayMongo account and finish business verification (needed to accept live payments). Use the `sk_test_...` key first to try it without real money.
2. **No server key is needed.** The server talks to Firestore through its REST API using the signed-in user's own token (`api/_firestore.js`). Billing records (plan, usage, trial, payments) are signed with an HMAC made from a secret you already have (`BILLING_SECRET` if you set it, otherwise your AI key / PayMongo key), and records without a valid signature are ignored, so users cannot give themselves Pro. Publish `firestore.rules` (they allow this).
3. PayMongo Dashboard → Developers → **Webhooks** → add `https://YOUR-DOMAIN/api/paymongo-webhook`, event `checkout_session.payment.paid`. Copy the signing secret into `PAYMONGO_WEBHOOK_SECRET`.
4. Re-publish `firestore.rules` (they changed: billing data is now read-only for users).

| Name | Value |
| --- | --- |
| `PAYMONGO_SECRET_KEY` | `sk_test_...` or `sk_live_...` |
| `PAYMONGO_WEBHOOK_SECRET` | webhook signing secret |
| `BILLING_SECRET` | optional, any long random text; signs billing records (defaults to an existing secret) |
| `PUBLIC_URL` | optional, e.g. `https://your-app.vercel.app` |

**Pricing (edit `TIERS()` in `api/_admin.js`; the page reads it from `/api/config`):**

| Plan | 30 days | 1 year | Generations | React | AI quality |
| --- | --- | --- | --- | --- | --- |
| Free, first 7 days (trial) | ₱0 | — | 10 | no (Bootstrap + Vanilla) | Low |
| Free, after day 7 | — | — | 0 | trial ended: a paid plan is required to generate | — |
| Starter | ₱150 | ₱1,000 | 30 | no | Low |
| Pro | ₱300 | ₱1,500 | 100 | yes | Standard |
| Business | ₱500 | ₱2,000 | 250 | yes | High |

**How generations come back:** on every plan, when a user uses up all their generations, they come back **24 hours after the moment the last one was used** (used up at 3 PM, back at 3 PM the next day). It is not a monthly or midnight reset. The allowance is checked and used atomically on the server (Firestore transaction); a generation is given back if the AI call fails. Free users are never locked out: after the 7-day trial they keep the Free plan in **Basic mode** (Vanilla only, simple prompt, 40% output size, no advanced features), and ZIP download works on every plan. The numbers (`gens`, `FREE_LIMIT`, `WINDOW_MS`) are in `api/_admin.js`. Because the allowance refills daily, a paid plan can use up to `gens` generations every day, so check your AI cost per generation against the plan price and lower `gens` if needed. `RATE_LIMIT_PER_HOUR` (default 60) is a separate anti-spam cap.

**AI quality is real, not a label.** Basic = simplest prompt and output budget; Low = faster replies using `gemini-3.5-flash-lite`; Standard and High use `gemini-3.8-flash` with larger output budgets. Override with `GEMINI_MODEL_LOW`, `GEMINI_MODEL_STANDARD`, `GEMINI_MODEL_HIGH`, or `GEMINI_MODEL`. The owner's **Test AI now** button tests all three levels. Pro Tools and React are included in Pro and Business only (`tools` and `react` in `TIERS()`). Change which plan gets which level in `TIERS()` (and `TRIAL_QUALITY`) in `api/_admin.js`.

The free use is counted on the server (Firestore `billing/trial`), atomically, so it cannot be bypassed. If the AI call fails, the use is refunded. Billing needs the published `firestore.rules`; if the database is unreachable `/api/generate` returns an error instead of giving free unlimited use. Without admin credentials a technically skilled user could still reset their own free usage counter by restoring an older signed record; they can never forge a plan or extend the trial. Use a live `sk_live_...` PayMongo key for real money.

Flow: Upgrade button → `/api/checkout` → PayMongo GCash checkout → back to `#/account` → `/api/billing` verifies the payment with PayMongo and activates Pro. Because the server has no admin access, the webhook cannot write a plan by itself: if the buyer closes the tab, the plan is activated automatically the next time they open the site (`/api/billing` checks their recent checkouts with PayMongo). Each payment is activated once only.

**Receipts / BIR:** PayMongo emails a payment receipt. This app does not issue BIR invoices. Registering with the BIR, issuing BIR-registered invoices and paying your own taxes are your responsibility as the seller; ask your accountant or BIR district office what applies to you.

## 3b. Pro Tools (`#/tools`, Pro members only)

- **Business ROI:** enter your price per website, sites per month and hours with and without AI. It shows hours saved, value of the time, net gain after the Pro price and a return percentage.
- **BIR Tax Estimator:** compares, for one year, the 8% option (8% of gross above ₱250,000; no ₱250,000 reduction for mixed-income earners; not available above ₱3,000,000), graduated rates with the 40% standard deduction, and graduated rates with itemized expenses (both plus 3% percentage tax). Graduated table: 0% up to ₱250,000, 15% to ₱400,000, 20% to ₱800,000, 25% to ₱2,000,000, 30% to ₱8,000,000, 35% above. It is a planning estimate, not tax advice. If BIR rates change, edit `graduatedTax()` and `calcBirTax()` in `assets/extras.js`.

The tools are calculators in the browser; the Pro check is a convenience gate, not a security boundary.

## 4. AI Debugger

Page `#/debug` (`/api/debug`). Paste an error and code, or press **Use current project**. Errors inside the live preview are caught automatically and a toast offers **Explain this error**. Answers are always in English with cause, fix steps and corrected code.

## 5. Releasing a new version

The version only goes up, never down, and never restarts. Every production deploy raises the patch number automatically (section 10), and every page shows the same number.

When you update the system or add a feature, do this before deploying:
1. In `version.json` raise `build` by 1 (for example 1 to 2). This is a floor, so the version is right even if Firestore is not connected.
2. Add a feature? Also raise `base` (for example `"2.4"` to `"2.5"`). The patch keeps counting; it does not restart (2.4.9 becomes 2.5.10).
3. Optionally set `RELEASE_NOTE` in Vercel for the text shown in What's new.

Open tabs on the old version show an "Update now" banner.

## 6. Owner account

`ronielnyke@gmail.com` (change with env `OWNER_EMAIL`, comma-separated for several) has full access: no free-trial limit, no monthly limit, no payment, React + Pro Tools + AI Debugger without hourly caps. The owner signs in with **Continue with Google**; there is no password in the code. Ownership is granted only when Firebase reports the email as **verified**, so nobody else can claim it by registering that address with a password.

## 7. Help assistant (clients)

A floating **Help** button (bottom-right, every page) opens an AI chat for clients (`/api/assistant`). It uses Gemini only. It is a general-purpose AI helper (any question, any language) that also knows this system: features, plans and prices (read live from `TIERS()` in `api/_admin.js`), GCash payments, the current version, and the signed-in user's own plan and usage. It uses Low quality by default for faster replies (`ASSISTANT_QUALITY=standard` or `high` selects a stronger, slower model). Unsupported Gemini models are retried with configured Gemini fallback models. It cannot change plans or refund. Limits: 60 messages per hour per user, signed-in users only, and it does not use up generations. Optional env `SUPPORT_CONTACT` (e.g. your email or Facebook page) is shown to users for refunds and payment problems; if unset, it tells them to contact the site owner.

## 8. Gemini AI

The generator (`/api/generate`), the AI Debugger (`/api/debug`) and the Help assistant (`/api/assistant`) all go through `api/_ai.js` and use Gemini only. `AI_PROVIDER`, `ANTHROPIC_API_KEY`, and `OPENAI_API_KEY` do not select an AI provider. Set `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) in Vercel Production and redeploy; a local `.env` is loaded only for local development and is not uploaded to Vercel. The owner Account setup panel shows whether Gemini's key is detected. After deploying, press **Test AI now (real request)** to confirm the key and model work. If the Gemini key has no quota, add billing or use a Gemini account with quota; other AI providers are intentionally not called. Gemini does not accept GIF images (JPG, PNG, WEBP only). The server may still use `ANTHROPIC_API_KEY` as a legacy billing-signature secret when `BILLING_SECRET` is unset, so do not remove it without configuring `BILLING_SECRET`.

## 9. Payments (GCash via PayMongo)

Checkout creates a PayMongo hosted checkout (GCash only) with the price taken from the server, never from the browser. The plan is activated only after PayMongo reports a **paid** payment whose amount covers the plan price, either when the buyer returns (or presses **Check payment**, which also finds payments made on another device) or through the signed webhook. Each payment can activate a plan only once. With a `sk_test_` key no real money moves; the pricing page says **TEST MODE** until you switch to `sk_live_`.

## 10. Automatic versions

You never edit the version number by hand. `GET /api/version` builds it as `MAJOR.MINOR.PATCH`:

- `MAJOR.MINOR` is the `base` in `version.json` (for example `"2.4"`). The patch never restarts when the base changes.
- `PATCH` goes up by **1 on every production deployment, forever**, whether or not you changed anything. It is counted in Firestore (`meta/version`), so every server instance agrees. Preview deployments never change it. It is stored in Firestore through the public `meta/version` rule in `firestore.rules`; if that rule is not published the version stays at `MAJOR.MINOR.BUILD` from `version.json`.
- `firebase.json` points Firebase CLI to this repository's rules. Publish them once (and again after rule changes) with `firebase deploy --only firestore:rules --project raw2code`; Vercel's `FIREBASE_PROJECT_ID` must point to the same project.
- Each release is saved with a note. The default note is "Improvements and fixes". Set `RELEASE_NOTE` in Vercel before deploying to write your own, or `RELEASE_NOTES_FROM_GIT=1` to use the git commit message (it becomes public, so leave it off if your commits are private).
- Open pages check `/api/version` every 5 minutes and when the tab is focused. When a new deployment is live they show **"Version vX.Y.Z is ready: note"** with an **Update now** button, and the version chip turns amber. The **Changelog** page lists the recent automatic updates, with the older highlights below.


## License

Proprietary. Copyright (c) 2026 Roniel Nyke Gonzales, Sibaguan, Lambunao, Iloilo, Philippines. All rights reserved. See `LICENSE`.
