# Accessibility conformance

**Target:** WCAG 2.1 level AA for both web apps (candidate app `/take/:token`, staff app `/admin`), which
is also the web requirement of ADA Title II/III guidance, Section 508 (via the Revised 508 Standards'
incorporation of WCAG 2.0 AA) and EN 301 549 clause 9. The candidate app has priority: **every candidate
must be able to take the exam**.

**Status (September 2026):** the candidate and staff apps are designed and tested to meet WCAG 2.1 AA,
with the known exceptions and limitations listed in [§4](#4-known-gaps-and-limitations). The biggest
limitation is inherent to camera proctoring, not to the web UI: the camera checks themselves assume that
the candidate can sit in front of a webcam and, by default, turn their head. Institutions must offer
the accommodations in [§5](#5-accommodations-what-to-offer-candidates).

This is a self-assessment made by the development team with automated checks and keyboard walkthroughs
(see [§3](#3-how-it-was-checked)). It is not a third-party audit. A manual screen-reader pass (NVDA +
Firefox/Chrome, JAWS + Chrome, VoiceOver + Safari) should be repeated before each major release and
recorded here; publish a formal accessibility conformance report (VPAT / ACR) from it if your
procurement requires one.

## 1. What the candidate app provides

| Area | Implementation | WCAG |
|---|---|---|
| Structure | Every screen has a `banner`, a `main` landmark and one `<h1>`; the exam screen adds `navigation` ("Questions") and a labelled `main` ("Current question"), plus a "Skip to the question" link. `<html lang="en">`. | 1.3.1, 2.4.1, 3.1.1 |
| Page titles | `document.title` names the screen and exam, e.g. "Camera check — Statistics 101 — SmartProctoring", "Question 3 of 5 — …", "Your exam is paused — …". | 2.4.2 |
| Focus on screen changes | When a screen or check step appears (camera check, calibration, identity check, result, ready, exam, paused, on hold, ended, errors), focus moves to its `<h1>`; when the question changes, focus moves to the question's `<h2>` ("Question 2 of 5"), so focus is never lost when a button disappears (e.g. "Next" becoming "Review and submit"). On the initial page load focus is not moved (reading starts at the top of the page). | 2.4.3, 3.2.1 |
| Keyboard | Everything is operable with the keyboard: consent checkbox, camera picker, retry buttons, question navigation (buttons with `aria-current="step"` and names like "Question 1, answered"), native radio / checkbox groups (arrow keys / Space), text and number fields, pause / submit / privacy dialogs. No keyboard traps outside modal dialogs. | 2.1.1, 2.1.2 |
| Questions | Each question is a `<fieldset>`; its `<legend>` holds the number, the points and the prompt (and "Select all that apply" for multiple choice), so screen readers read the whole question when entering the answer controls. Text answers have a visible "Your answer" label. | 1.3.1, 3.3.2, 4.1.2 |
| Errors | Invalid numeric answers set `aria-invalid` and the message ("Enter a number, for example 42 or 3.5") is the field's `aria-describedby` and announced politely. A missing pause reason is shown in an alert, tied to the field (`aria-invalid`, `aria-describedby`) and the focus moves to it. | 3.3.1, 3.3.3 |
| Dialogs | Pause, pause-pending, submit, privacy notice and the "Return to fullscreen" overlay are modal: focus moves in (the safe choice, e.g. "Back to exam"), Tab / Shift+Tab stay inside, the page behind is `inert`, Escape closes the non-critical ones (not while an action is running, never the fullscreen overlay), and focus returns to the button that opened them. | 2.1.2, 2.4.3 |
| Live regions | Visible messages sit in persistent live regions that exist before the message appears, so each is announced once and the text is never duplicated. **Assertive** only for blocking states: "Live reporting is interrupted…" and the hold message on "Your exam is on hold". **Polite**: monitoring prompts ("Please look at the screen"), the camera-problem banner, "Time is up", notifications, the readiness status line, the identity-check instruction ("Turn your head to the left"), check guidance, and autosave ("Answer saved automatically", once per question). A hidden announcer (`announce()`) is used only for things with no visible text: the countdown marks and "Connection restored". | 4.1.3 |
| Countdown | The remaining time is a `role="timer"` (not a live region) and is **not** read out every second. It is announced politely at 10, 5 and 1 minute(s) remaining ("5 minutes remaining. Your answers are saved automatically."). Staff can extend the time ("Extend time…"). | 2.2.1, 4.1.3 |
| Camera checks as text | The readiness checklist items carry "OK / not yet / warning" text (not only ✓ / colour); a status line says what to fix next or "All checks passed. Select Continue."; the liveness arrows are decorative — the instruction is text, and the steps list states "(done)" / "(current step)". | 1.1.1, 1.3.3, 1.4.1 |
| Colour | Text, badges and banners meet 4.5:1; form-control borders and the focus ring 3:1 (tokens in `apps/web/src/styles.css`, guarded by `src/lib/a11y.test.ts`). Status dots always come with text ("Monitoring active — please check the camera view"). | 1.4.1, 1.4.3, 1.4.11 |
| Focus visible | A 3 px focus ring (`:focus-visible`, `--focus`, ≥ 3:1) on every control, a light ring on dark backgrounds. | 2.4.7 |
| Zoom / reflow | Usable at 200 % zoom and at 320 CSS px without horizontal scrolling; the sticky exam header becomes static on small or short viewports so it never covers the question. | 1.4.4, 1.4.10 |
| Motion | `prefers-reduced-motion: reduce` switches off animations and transitions (spinners, pulses, highlights). Nothing flashes. | 2.3.1, 2.3.3 (AAA, best effort) |
| Accommodations note | The welcome screen has an "Accessibility & accommodations" section: keyboard and screen-reader use, and the privacy contact for accommodations (exam without the head-movement check, extra time). | — |
| Small screens / no camera | On a phone-sized screen, or when no camera is found, the welcome screen shows a friendly "This exam needs a computer with a webcam" notice. It warns, it does not block: if the camera works, the candidate can continue. | — |

## 2. What the staff app provides

| Area | Implementation |
|---|---|
| Structure | Skip link ("Skip to main content"), labelled navigation ("Main"), `main`, one `<h1>` per page, per-route document titles ("Session details — SmartProctoring staff"). The sign-in page is a `main` with a labelled form. |
| Labels | Every control has an accessible name: filter selects, search fields, note fields (placeholders are not used as labels), row actions ("Approve pause for <candidate>"), icon buttons ("Close", "Previous image"). Policy-editor fields are described by their default / help / error text; the "changed" dot has text. |
| Tabs | Session detail tabs and the dashboard's status filter are WAI-ARIA tabs: `tablist` / `tab` / `tabpanel`, one tab stop, ←/→/Home/End with automatic activation, tab panels labelled by their tab. |
| Tables | Clickable rows also contain a real link or button (candidate name, event title), so every row is reachable and operable with the keyboard; sortable headers use `aria-sort` and decorative arrows are hidden. |
| Drawer, dialogs | The event drawer and every modal move focus in, trap Tab, make the page behind inert, close with Escape (only the top-most one) and return focus to the opener. |
| Image viewer | Modal with Close / Previous / Next buttons, ← / → / Escape, "image 2 of 5" announced politely, "Open original (opens in a new tab)". |
| Evidence images | Text alternatives say what, when and why: "Webcam screenshot at 10:32:05 — More than one person in view", "Identity reference image at 09:58:12", "Webcam identity sample at 10:40:31 — identity check (resume), Different person". Thumbnails inside already-labelled buttons are decorative (`alt=""`). |
| New flags | New non-neutral flags on the live dashboard are announced politely and rate-limited (batched; at most one announcement every 15 s: "3 new flags. Latest: Integrity: More than one person in view — Jane Doe"). |
| Colour | Category / severity / status badges meet 4.5:1 and always carry text; compact category counters show a letter (I / U / T) and a screen-reader label, not only a coloured dot. Disabled / completed items are no longer faded below contrast. |

## 3. How it was checked

* **Automated, in the e2e suite** — `e2e/tests/14-accessibility.spec.ts` with the in-repo checker
  `e2e/lib/a11y.ts` (no third-party rule engine). The checker reads **Chromium's computed
  accessibility tree** over CDP and fails on: interactive elements, images, dialogs, tab panels and
  focusable containers without an accessible name; pages without `main` or `<h1>`; missing `lang` or
  title; duplicate ids; broken `aria-labelledby` / `aria-describedby` / `aria-controls` references; and
  visible text below 4.5:1 (3:1 for large text) against its computed background; fields labelled
  only by a placeholder. It runs on the candidate welcome, camera-check, ready, exam, submit-dialog,
  paused, resume-intro, check-result and ended screens and the welcome screen at 320 px, and on
  **every staff page** (sign-in, live dashboard, sessions, session detail tabs, event drawer, report,
  exams, exam detail / edit / new, candidates, candidate detail, quality, audit log, settings,
  integrations, users). The checker itself was verified against a page with planted problems.
* **Keyboard walkthroughs (same spec)** — a candidate completes consent → camera check → start →
  single choice, multiple choice, short text, numeric (with an invalid value) and long text → question
  navigation → submit dialog → privacy dialog → pause dialog (missing reason, Escape, pause) → resume
  (intro → camera check → "Check complete") → submit → ended, using only Tab / Shift+Tab / arrows /
  Space / Enter / Escape. It asserts where the focus lands after every screen
  and question change, that dialogs trap focus and return it, that the page behind a dialog is inert,
  that the countdown is a timer announced at the 10-minute mark and never as a clock value, and that
  nothing scrolls sideways at 320 px. On the staff side it drives the dashboard status tabs, the session
  tabs, an events-table row → drawer → Escape, and the identity reference image → viewer → arrows →
  Escape, and checks that a new flag was announced and that announcements were rate-limited.
* **Small screens / no camera / reduced motion** — the second test opens the welcome screen at 320 px
  with no camera and `prefers-reduced-motion: reduce`: the notice appears, consent stays possible, the
  page reflows and animations are off.
* **Unit tests** — `apps/web/src/lib/a11y.test.ts`: contrast of every colour token, badge and banner in
  `styles.css` (text 4.5:1, borders / focus ring 3:1), the countdown announcement marks, tab keyboard
  logic.
* **Manual review** — code review of all candidate screens and the main staff pages against WCAG 2.1
  AA success criteria.

Not yet done: a full manual pass with screen readers (NVDA, JAWS, VoiceOver, TalkBack is out of scope —
phones are not supported for exams), Windows High Contrast / forced-colours testing, speech input
(Dragon) testing, and testing with disabled users. These are required before claiming full conformance
in an ACR.

## 4. Known gaps and limitations

| # | Gap | Impact | Mitigation / plan |
|---|---|---|---|
| 1 | **The live-person check requires turning one's head** (policy `identity.liveness: 'active'`, the default). | Candidates who cannot turn their head (e.g. neck or motor impairments), or who cannot see the arrows and follow timed spoken instructions quickly enough, may be unable to pass the check. The instructions are text and announced, and the attempt times out gracefully with retries, but the task itself is physical. | Accommodation: create a separate exam (or exam variant) for that candidate with **Live-person check = Off** (`identity.liveness: 'off'` in the exam's policy). Identity is then still compared with the reference; only the head-movement challenge is skipped. See §5. |
| 2 | **Camera-based proctoring may not suit some disabilities** — e.g. candidates who need to look away from the screen (using a magnifier, a braille display, notes in another format), involuntary movements (tics, spasms), a support person or interpreter in the room, facial differences, or no usable camera position. Such behaviour can produce "looking away", "unusual movement", "more than one person" or "unable to verify" observations. | Observations are never verdicts: staff review every flag with evidence and context, and "unable to verify" is never treated as a different person. Still, unnecessary flags are a burden. | Offer alternative arrangements (§5): relax or disable the relevant detections in that exam's policy, record the accommodation in a session note so reviewers see it, or use a different supervision method (in-person or live remote invigilation). |
| 3 | **Identity-check guidance is visual first.** Framing hints ("move closer", "your face is cut off") are text and announced, but positioning oneself in front of a camera without sight is hard. | Blind candidates may need several attempts. | Accommodation: a support person may help set up the camera before the exam; staff can release a hold after verifying identity by other means (video call). |
| 4 | **Notifications (toasts) disappear after 8–12 s.** | Slow readers may miss them visually (screen readers announce them). The important states they report (pause approved / denied) are also reflected on screen. | Planned: keep notifications until dismissed, or pause the timer on hover / focus. |
| 5 | **Fullscreen requirement.** When the exam requires fullscreen, leaving it (which some assistive technology or magnifier workflows do) is recorded and shows a blocking "Return to fullscreen" dialog. | Can interfere with screen magnifiers or assistive apps that open their own windows. | Accommodation: exam policy **Require fullscreen = Off** for that candidate. |
| 6 | **Copy / paste blocking** (`browser.blockClipboard`) also blocks pasting from assistive or dictation tools that use the clipboard. | Speech-input users may be affected. | Accommodation: exam policy **Block copy / paste = Off**. |
| 7 | **Session timeout / time limit** — the exam duration is a time limit. | WCAG 2.2.1 requires a way to extend it. | Staff can extend time at any moment ("Extend time…" on the session page); give extra time up front for candidates with that accommodation. |
| 8 | **Staff app on small screens** — the staff app reflows at 320 px, but wide data tables (events, sessions, audit log) scroll horizontally inside their frame. | Allowed by WCAG 1.4.10 for data tables; tedious at high zoom. | Use the session timeline (single column) or the report page at high zoom. |
| 9 | **Some staff forms put error text inside the `<label>`** (exam editor, settings, integrations). The error is part of the field's accessible name rather than its description. | Conformant but verbose. | Planned: move to `aria-describedby` like the policy editor. |
| 10 | **Charts and the similarity scale** on the comparison and quality pages are visual. | Their values are also given as text (similarity numbers, thresholds, tables). | — |
| 11 | **Language** — the UI is English only. | Candidates who need another language (or plain-language instructions) are not served. | Planned: localisation. |

## 5. Accommodations: what to offer candidates

The welcome screen tells candidates to contact the privacy contact (organisation *Settings → privacy
contact*, shown in the privacy notice) **before the exam** if they need an accommodation. Staff can offer, per candidate:

1. **Exam without the head-movement check** — duplicate the exam (or create a variant) and set
   *Identity & liveness → Live-person check* to **Off** (`identity.liveness: 'off'`); assign the candidate
   to that exam. The identity reference and the identity comparisons still run.
2. **Extra time** — set a longer duration on the variant, or use **Extend time…** on the session page
   (audit-logged, the candidate's clock updates live).
3. **No fullscreen / clipboard restrictions** — *Browser → Require fullscreen* and *Block copy / paste* off.
4. **Relaxed detections** — for candidates who look away or move by necessity, raise the thresholds or
   turn off *looking away* / *unusual movement* in the variant's policy, and add a session note so
   reviewers know.
5. **A support person or interpreter** — note it in the session so "more than one person" observations
   are reviewed in that light.
6. **Alternative arrangements** — when camera proctoring is not suitable at all, use another
   supervision method (in-person or live remote invigilation) instead of forcing the camera checks.

Record accommodations in the candidate's or session's notes; do not record medical details.

## 6. For developers

* Shared helpers: `apps/web/src/lib/a11y.ts` (`ScreenHeading` focus / titles via `useFocusOnMount` and
  `useDocumentTitle`, `useDialogFocus` for modals, `tabProps` for tablists, `announce()` +
  `LiveAnnouncer` for live regions, `countdownAnnouncement`, `contrastRatio`).
* New screens: render the `<h1>` with `ScreenHeading` (candidate) or `PageHeader` (staff); new dialogs:
  use the existing `Modal` components (they already manage focus); new colours: add them as tokens in
  `styles.css` — `src/lib/a11y.test.ts` checks badges and banners automatically.
* Announce changes that happen without user action with `announce(message, 'polite')`; use
  `'assertive'` only for states that block the candidate. Never put a ticking value in a live region.
* Keep `data-testid` attributes; run `pnpm --filter @sp/e2e exec playwright test tests/14-accessibility.spec.ts`
  after UI changes.
