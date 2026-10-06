# Selenium Recorder — Chrome Extension

Records interactions on any web page (including inside iframes) and
generates ready-to-run **Selenium + Python** automation, either as a
bare linear script or a full **Page Object Model** project with Pytest
or unittest.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Pin the extension so its icon is visible in the toolbar.

## Using it

1. Navigate to the page you want to test, then click the extension
   icon and hit **Record**.
2. Interact with the page normally — clicks, typing, pasting, checkboxes/
   radios, single- and multi-select dropdowns, Enter/Tab, scrolling
   (window or an inner scrollable container), full-page navigations, and
   tab creation/switching are captured, including interactions inside
   embedded `<iframe>`s. A scroll gesture is
   debounced into one step for its final resting position, not one
   step per frame of movement; pasted text is tagged as such in the
   generated comments (still replayed as `send_keys`, since that's the
   reliable way to reproduce the resulting value). A field's value is
   captured even if autofill or paste never fires a standard
   `input`/`paste` event. While recording, the extension checks text
   fields for value changes and captures populated values after a short
   debounce, including values filled without focusing the field.
3. While recording, use **✂ New Section** (type a name, then click it)
   to manually mark a new logical page/class boundary — even without a
   real page navigation. This matters for single-page apps where a
   multi-step wizard (e.g. a payout form's "toggle account type" →
   "enter beneficiary" → "enter ultimate beneficiary" steps) never
   changes the URL at all: without a marker, everything would land in
   one class; with one, each labeled section becomes its own
   `<Name>Action`/`<Name>Locators` pair while the ordered actions remain
   in the same generated test, instantiated from the entry page's
   `.driver` rather than given its own (nonexistent) URL to open.
4. Use **Pause/Resume** to temporarily stop capturing without losing
   the session, **Stop** to end the session, and **Clear** to reset.
5. In the popup, each recorded step can be:
   - Edited inline (✎ — change the typed value or the locator).
   - Deleted (✕).
   - Reordered via drag-and-drop.
   - Validated for missing values/locators; potentially fragile CSS/XPath
     locators are flagged before replay or export.
   Mark input values as **Secret** to mask them in the popup and export
   them through environment variables. Values remain in Chrome's local
   extension storage for replay; masking does not encrypt that local data.
6. Add explicit waits or assertions (element present, visible, or expected
   text) from the popup when a flow needs a checkpoint.
7. Optionally **Save** the session under a name so you can **Load**
   it again later (stored locally via `chrome.storage.local`).
8. Click **Replay** to play the current step list back across the
   recorded tabs — useful for sanity-checking before you export.
9. Set **Project name**, choose **Linear** or **Page Object Model**, and
   select Pytest or unittest. **Preview generated files** lets you inspect
   each output file before downloading the ZIP.

## Settings (⚙ in the popup header)

Choose which browsers the generated tests target: Chrome, Edge,
Firefox, any combination. This drives the `driver_setup` pytest
fixture in Pytest POM exports:
- **Multiple browsers checked** → a parametrized fixture
  (`params=["chrome", "edge", ...]`) that runs the whole suite once
  per browser.
- **One browser checked** → a plain, non-parametrized fixture for
  just that browser.

The same setting also picks which single browser the **Linear**
export uses (the first checked browser, top to bottom). Settings
persist via `chrome.storage.local` and default to all three browsers
if never changed. Toggle generated action logging and failure screenshots
here as well. unittest exports use the first selected browser; Pytest POM
exports can run across every selected browser.

## Locator strategy

Locators are chosen in this priority order, each checked for
page-wide uniqueness before being accepted:

1. `id`
2. `name`
3. `data-testid` / `data-test-id` / `data-test` / `data-qa` / `data-cy`
4. Accessible roles/names and attributes (`role` with visible name,
   `aria-label`, `aria-labelledby`, and `title`)
5. A generated CSS selector (tag + stable classes + `:nth-of-type`)
6. XPath (fallback only)

Potentially fragile CSS/XPath locators are highlighted so they can be
replaced with a stable ID, test attribute, or accessible selector.

Clicking a `<label>` that wraps or targets a form control resolves to
that control itself (not the label), and checkboxes/radios are
recorded exactly once via their native `change` event rather than
also being picked up by the click handler.

## Generated project layout

**Linear** — a direct script, Pytest test, or unittest case depending on
the selected test runner:
```
tests/
    test_recorded_flow.py
requirements.txt
README.md
```
```python
from selenium import webdriver
from selenium.webdriver.common.by import By

driver = webdriver.Chrome()

driver.get("https://example.com/login")
driver.maximize_window()
driver.find_element(By.ID, "username").send_keys("admin")
driver.find_element(By.ID, "submit").click()

driver.quit()
```
Run it with `python tests/test_recorded_flow.py`.

**Page Object Model:**
```
config/
    config.py
Pages/
    <Page>Action/
        <page>Page.py
    <Page>Locators/
        <page>Locators.py
tests/
    test_<project>.py
screenshots/
requirements.txt
README.md
```
Pages are grouped automatically by URL path at recording time; the
same page visited more than once reuses its existing class instead of
generating a duplicate. Each page's Action class:
- has a `open_<page>_page(url)` navigation method,
- has one method per interaction, each wrapped in `try/except` that
  waits for targets (`element_to_be_clickable` for clicks, presence for
  fields), logs action-specific failures via `self.logger`, catches
  `TimeoutException` /
  `ElementClickInterceptedException` / `NoSuchElementException` /
  `StaleElementReferenceException` specifically (screenshot +
  re-raise), then falls back to a generic `Exception` handler with
  the same behavior; following actions wait for their target elements,
  without embedding destination URLs in the action methods,
- writes failure screenshots to `screenshots/` via `_take_screenshot`.

The `driver_setup` fixture (shaped by your browser Settings) lives in
`tests/test_<project>.py` along with an entry-page fixture named after
whichever page the recording opens first (e.g. `login`), which returns
that page object directly with the initial navigation already done.
The complete flow is then emitted as **one ordered test function** using
that fixture. It switches pages and tabs in sequence while sharing the
same browser session, so the generated test reads like a hand-written
scenario from start to finish.
The initial page is opened by the fixture. Later URL changes caused by
recorded interactions are not repeated as direct URL opens in the test;
the recorded clicks and other actions drive those transitions.
The browser fixture uses headless mode by default, as in the sample test.
Tab-handle bookkeeping is included only when the recording opens or
switches browser tabs; single-tab tests omit recorder tab IDs.

Run it with:
```bash
pip install -r requirements.txt
pytest tests/ -v
```
(Selenium 4.10+ resolves driver binaries automatically; `webdriver-manager`
is included as a fallback.)
Each Pytest run also creates a self-contained `report.html` with a QA
dashboard, execution totals, environment details, and the detailed test
results and failure tracebacks.
The popup can also generate a `unittest` runner. That runner executes the
flow in one test case and uses the first selected browser.

## Architecture

| File | Responsibility |
|---|---|
| `content/content.js` | Listens for real DOM events (in every frame, including iframes) while recording; builds locators; executes replay steps against the live page. |
| `background.js` | Owns recorder state and steps; persists to `chrome.storage.local`; tracks navigation and tab transitions; orchestrates replay per tab and frame. |
| `popup/` | Controls recording, step validation/editing, save/load, waits/assertions, export configuration and file preview. |
| `options/` | Settings page — target browsers, generated logging and screenshot options. |
| `lib/codegen.js` | Pure functions that turn a step list into Linear or POM Python source files. |
| `lib/validation.js` | Validates edited steps and flags potentially fragile locators. |
| `lib/zip.js` | Minimal dependency-free ZIP (store method) writer — used instead of a bundled third-party library since MV3 disallows fetching remote code. |

## Known limitations / possible follow-ups

- Duplicate/no-op action collapsing is heuristic (identical
  back-to-back steps), not a full semantic optimizer.
- `contenteditable` elements (rich-text editors) are captured using
  their visible text; complex formatting/rich content isn't preserved.
