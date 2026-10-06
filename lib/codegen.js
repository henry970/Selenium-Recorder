/**
 * Translates recorded steps (see content/content.js for the step
 * shape) into either:
 *   - a single linear pytest script, or
 *   - a full Page Object Model project
 *
 * Both generators return a flat map of { "relative/path.py": "source" }
 * which the popup then feeds into ZipWriter (lib/zip.js).
 *
 * Generated code supports configurable logging/screenshots, explicit
 * Selenium waits, a `Config` class, and selectable test runners.
 */

// ---------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------
function pyStr(value) {
  const s = String(value == null ? '' : value);
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n/g, '\\n')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\n')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

function pyValue(value) {
  if (Array.isArray(value)) return `[${value.map(pyStr).join(', ')}]`;
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return pyStr(value);
}

// Collapses whitespace (including embedded newlines — real page text can
// contain them if a whole container's innerText got captured as a
// description) into single spaces, trims, and truncates. Returns raw
// text with no escaping — safe to feed into pyStr(), which does its own
// escaping, but NOT safe to embed directly inside a string literal.
function collapseWhitespace(value, maxLen = 60) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

// Same whitespace collapsing, plus backslash/quote escaping — safe to
// embed directly inside an existing "..." or """...""" literal (the
// caller supplies the surrounding quotes). Used for docstrings and
// f-strings where the text is spliced into a template that already has
// its own quote characters, rather than being wrapped by pyStr().
function cleanLabel(value, maxLen = 60) {
  return collapseWhitespace(value, maxLen)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

// Whitespace-collapsed only, no escaping — for embedding in a `#`
// comment, which isn't a string literal so stray quotes are harmless,
// but a raw newline would still break the comment (and everything
// after it) onto invalid new lines.
function cleanComment(value, maxLen = 80) {
  return collapseWhitespace(value, maxLen);
}

function byTupleFor(locator) {
  if (!locator) return null;
  const map = { id: 'By.ID', name: 'By.NAME', css: 'By.CSS_SELECTOR', xpath: 'By.XPATH', aria: 'By.CSS_SELECTOR', test: 'By.CSS_SELECTOR', role: 'By.XPATH' };
  const by = map[locator.strategy] || 'By.CSS_SELECTOR';
  return `(${by}, ${pyStr(locator.value)})`;
}

// Unwrapped form for direct find_element(By.X, "value") calls —
// find_element() takes two positional args, not a (By, value) tuple.
function byArgsFor(locator) {
  if (!locator) return null;
  const map = { id: 'By.ID', name: 'By.NAME', css: 'By.CSS_SELECTOR', xpath: 'By.XPATH', aria: 'By.CSS_SELECTOR', test: 'By.CSS_SELECTOR', role: 'By.XPATH' };
  const by = map[locator.strategy] || 'By.CSS_SELECTOR';
  return `${by}, ${pyStr(locator.value)}`;
}

function slugify(text, fallback = 'element') {
  const cleaned = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30);
  return cleaned || fallback;
}

function toPascalCase(slug) {
  return slug
    .split('_')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');
}

function uniqueName(base, usedSet) {
  let candidate = base;
  let i = 2;
  while (usedSet.has(candidate)) {
    candidate = `${base}_${i}`;
    i += 1;
  }
  usedSet.add(candidate);
  return candidate;
}

function pageKeyFromUrl(url) {
  try {
    const u = new URL(url);
    let path = u.pathname.replace(/\/+$/, '');
    if (!path || path === '') return 'home';
    return slugify(path, 'page');
  } catch (err) {
    return 'page';
  }
}

// First URL path segment becomes the top-level feature/module folder,
// e.g. /identity/login -> "identity", /gbp_payout/transfer -> "gbp_payout".
function moduleKeyFromUrl(url) {
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter(Boolean);
    if (!segments.length) return 'app';
    return slugify(segments[0], 'app');
  } catch (err) {
    return 'app';
  }
}

// Last URL path segment becomes the page-level name used for the
// <Page>Action / <Page>Locators subfolders and class names,
// e.g. /identity/login -> "login".
function pageNameFromUrl(url) {
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter(Boolean);
    if (!segments.length) return 'home';
    return slugify(segments[segments.length - 1], 'page');
  } catch (err) {
    return 'page';
  }
}

// Remove back-to-back steps that are functionally identical (same
// type, locator and value) — a lightweight "duplicate action" filter
// on top of the record-time dedupe in background.js.
function collapseDuplicates(steps) {
  const result = [];
  for (const step of steps) {
    const prev = result[result.length - 1];
    if (
      prev &&
      prev.type === step.type &&
      JSON.stringify(prev.locator) === JSON.stringify(step.locator) &&
      prev.value === step.value
    ) {
      continue;
    }
    result.push(step);
  }
  return result;
}

function isInteractionType(type) {
  return ['click', 'input', 'select', 'keydown', 'scroll'].includes(type);
}

function tabKey(tabId) {
  return tabId == null ? 'active' : tabId;
}

// Shared base-name builder used by both the method name and the
// locator constant name, so they stay in lockstep — e.g. a click on
// "Account button" yields method `click_account_button` and locator
// `CLICK_ACCOUNT_BUTTON`.
function actionSlugFor(step) {
  const target = slugify(step.description, step.elementType || 'element');
  switch (step.type) {
    case 'click':
      return `click_${target}`;
    case 'input':
      return `enter_${target}`;
    case 'select':
      return `select_${target}`;
    case 'keydown':
      return `press_${slugify(step.key)}_on_${target}`;
    case 'scroll':
      return `scroll_${target}_${step.direction || 'to_position'}`;
    default:
      return target;
  }
}

function methodNameFor(step, usedNames) {
  return uniqueName(actionSlugFor(step), usedNames);
}

function locatorNameFor(step, usedNames) {
  return uniqueName(actionSlugFor(step).toUpperCase(), usedNames);
}

function describeStepComment(step) {
  const desc = cleanComment(step.description);
  if (step.type === 'scroll') {
    return `Scroll ${step.direction || ''} on "${desc}" to (${step.scrollX}, ${step.scrollY})`;
  }
  const label = { click: 'Click', input: step.viaPaste ? 'Paste into' : 'Enter text into', select: 'Select option in', keydown: 'Press key on' }[step.type] || 'Interact with';
  return `${label} "${desc}" (${step.locator ? step.locator.strategy : 'n/a'})`;
}

function lowerFirst(s) {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}

function isSecretField(step) {
  return Boolean(step.isSecret);
}

function environmentNameFor(key) {
  return `SELENIUM_RECORDER_${key}`;
}

// Walks every input/select step once and assigns each a Config
// constant name based on its field description. The same field
// description reuses the same constant if it appears more than once.
// Mutates each qualifying step with a `configKey` property and
// returns the ordered list of { key, value } entries for config.py.
function assignConfigKeys(steps) {
  const descToKey = new Map();
  const usedKeys = new Set(['PROJECT_NAME', 'BASE_URL', 'DEFAULT_TIMEOUT']);
  const entries = [];

  for (const step of steps) {
    if (step.type !== 'input' && step.type !== 'select') continue;

    const secret = isSecretField(step);
    const baseKey = slugify(step.description, 'field').toUpperCase();

    const dedupeId = `field:${(step.description || '').toLowerCase().trim()}`;
    let key = descToKey.get(dedupeId);
    if (!key) {
      key = uniqueName(baseKey, usedKeys);
      descToKey.set(dedupeId, key);
      entries.push({
        key,
        value: step.value,
        envVar: secret ? environmentNameFor(key) : null
      });
    } else if (secret) {
      const entry = entries.find((item) => item.key === key);
      if (entry && !entry.envVar) entry.envVar = environmentNameFor(key);
    }
    const configEntry = entries.find((item) => item.key === key);
    step.configKey = key;
    step.isSecret = Boolean(configEntry && configEntry.envVar);
    step.envVar = configEntry ? configEntry.envVar : null;
  }

  return entries;
}

function methodArgFor(step) {
  if (step.configKey) return `Config.${step.configKey}`;
  if (step.type === 'input') return pyValue(step.value);
  if (step.type === 'select') return pyValue(step.value);
  return null;
}

function findBaseUrl(steps, config) {
  const nav = steps.find((s) => s.type === 'navigate');
  return (nav && nav.value) || config.baseUrl || 'https://example.com';
}

// Shared multi-browser driver fixture body (chrome / edge / firefox),
// parametrized and module-scoped so a whole flow runs once per browser.
const CONFIXHUB_LOGO_DATA = (typeof CONFIXHUB_LOGO_B64 !== 'undefined')
  ? CONFIXHUB_LOGO_B64
  : (typeof require === 'function' ? require('./logo.js').CONFIXHUB_LOGO_B64 : '');

const BROWSER_META = {
  chrome: {
    optionsClass: 'ChromeOptions',
    optionsClassSolo: 'Options',
    optionsVar: 'chrome_options',
    webdriverCall: 'webdriver.Chrome',
    importLine: 'from selenium.webdriver.chrome.options import Options as ChromeOptions',
    importLineSolo: 'from selenium.webdriver.chrome.options import Options',
    extraLines: [
      'chrome_options.add_argument("--disable-gpu")',
      'chrome_options.add_experimental_option("prefs", {"credentials_enable_service": False, "profile.password_manager_enabled": False})  # No password-manager popups'
    ],
    headlessComment: 'chrome_options.add_argument("--headless")  # Run Chrome in headless mode'
  },
  edge: {
    optionsClass: 'EdgeOptions',
    optionsClassSolo: 'Options',
    optionsVar: 'edge_options',
    webdriverCall: 'webdriver.Edge',
    importLine: 'from selenium.webdriver.edge.options import Options as EdgeOptions',
    importLineSolo: 'from selenium.webdriver.edge.options import Options',
    extraLines: [
      'edge_options.add_argument("--disable-gpu")',
      'edge_options.add_experimental_option("prefs", {"credentials_enable_service": False, "profile.password_manager_enabled": False})  # No password-manager popups'
    ],
    headlessComment: 'edge_options.add_argument("--headless")  # Run Edge in headless mode'
  },
  firefox: {
    optionsClass: 'FirefoxOptions',
    optionsClassSolo: 'Options',
    optionsVar: 'firefox_options',
    webdriverCall: 'webdriver.Firefox',
    importLine: 'from selenium.webdriver.firefox.options import Options as FirefoxOptions',
    importLineSolo: 'from selenium.webdriver.firefox.options import Options',
    extraLines: [],
    headlessComment: 'firefox_options.add_argument("-headless")  # Run Firefox in headless mode'
  }
};
const CANONICAL_BROWSER_ORDER = ['chrome', 'edge', 'firefox'];

function normalizeBrowsers(browsers) {
  const selected = CANONICAL_BROWSER_ORDER.filter((b) => (browsers || CANONICAL_BROWSER_ORDER).includes(b));
  return selected.length ? selected : ['chrome'];
}

function browserImportLines(browsers) {
  const selected = normalizeBrowsers(browsers);
  // A single configured browser doesn't need the "as ChromeOptions"
  // aliasing — that's only there to disambiguate multiple Options
  // classes imported together.
  if (selected.length === 1) return BROWSER_META[selected[0]].importLineSolo;
  return selected.map((b) => BROWSER_META[b].importLine).join('\n');
}

// Lines that create `target` for non-fixture exports; Chrome/Edge also
// disable password-manager popups that would interrupt the run.
function driverCreationLines(browser, target, indent) {
  const meta = BROWSER_META[browser];
  let lines;
  if (browser === 'firefox') {
    lines = [`${target} = ${meta.webdriverCall}()`];
  } else {
    const optionsClass = browser === 'edge' ? 'webdriver.EdgeOptions' : 'webdriver.ChromeOptions';
    lines = [
      `options = ${optionsClass}()`,
      'options.add_experimental_option("prefs", {"credentials_enable_service": False, "profile.password_manager_enabled": False})',
      `${target} = ${meta.webdriverCall}(options=options)`
    ];
  }
  return lines.map((l) => indent + l).join('\n');
}

function driverSetupFixture(browsers) {
  const selected = normalizeBrowsers(browsers);

  if (selected.length === 1) {
    // Only one browser configured in Settings — no need for a
    // parametrized request.param branch, just build that driver directly.
    const meta = BROWSER_META[selected[0]];
    const extra = meta.extraLines.map((l) => `    ${l}`).join('\n');
    return `@pytest.fixture(scope="module")
def driver_setup():
    ${meta.optionsVar} = ${meta.optionsClassSolo}()
    ${meta.headlessComment}
${extra ? extra + '\n' : ''}    driver = ${meta.webdriverCall}(options=${meta.optionsVar})

    driver.implicitly_wait(30)
    driver.maximize_window()
    yield driver
    driver.quit()`;
  }

  const branches = selected.map((b, i) => {
    const meta = BROWSER_META[b];
    const keyword = i === 0 ? 'if' : 'elif';
    const extra = meta.extraLines.map((l) => `        ${l}`).join('\n');
    return `    ${keyword} browser == "${b}":
        ${meta.optionsVar} = ${meta.optionsClass}()
        ${meta.headlessComment}
${extra ? extra + '\n' : ''}        driver = ${meta.webdriverCall}(options=${meta.optionsVar})`;
  });

  const paramsList = selected.map((b) => pyStr(b)).join(', ');

  return `@pytest.fixture(scope="module", params=[${paramsList}])
def driver_setup(request):
    browser = request.param

${branches.join('\n\n')}

    else:
        raise ValueError(f"Unsupported browser: {browser}")

    driver.implicitly_wait(30)
    driver.maximize_window()
    yield driver
    driver.quit()`;
}

// ---------------------------------------------------------------
// LINEAR generator
// ---------------------------------------------------------------
function buildLinearProject(rawSteps, config) {
  const steps = collapseDuplicates(rawSteps);
  const testDataEntries = assignConfigKeys(steps);
  const environmentVariables = testDataEntries.filter((entry) => entry.envVar);
  const lines = [];
  const usesSelect = steps.some((s) => s.type === 'select');
  const usesKeys = steps.some((s) => s.type === 'keydown');
  const usesWait = steps.some((s) => s.type === 'wait');
  const usesUnittest = config.testRunner === 'unittest';
  const usesPytest = config.testRunner === 'pytest';

  let first = true;
  const interactionTabs = new Set();
  const usesMultipleTabs = steps.some((step) => step.type === 'tab_open' || step.type === 'tab_switch');
  const initialTabId = steps.find((step) => step.tabId != null)?.tabId;
  for (const step of steps) {
    if (isInteractionType(step.type)) interactionTabs.add(tabKey(step.tabId));
    if (step.type === 'tab_open') {
      if (interactionTabs.has(tabKey(step.openerTabId))) interactionTabs.add(tabKey(step.tabId));
      lines.push(`new_handles = [handle for handle in driver.window_handles if handle not in known_handles]`);
      lines.push(`if new_handles:`);
      lines.push(`    driver.switch_to.window(new_handles[-1])`);
      lines.push(`else:`);
      lines.push(`    driver.switch_to.new_window("tab")`);
      lines.push(`tab_handles[${pyValue(step.tabId)}] = driver.current_window_handle`);
      lines.push(`known_handles = set(driver.window_handles)`);
      continue;
    }
    if (step.type === 'tab_switch') {
      lines.push(`driver.switch_to.window(tab_handles[${pyValue(step.tabId)}])`);
      continue;
    }
    if (step.type === 'navigate') {
      const navigationTabKey = tabKey(step.tabId);
      if (interactionTabs.has(navigationTabKey)) {
        interactionTabs.delete(navigationTabKey);
        continue;
      }
      if (first) {
        // The very first navigation opens the browser session.
        lines.push(`driver.get(${pyStr(step.value)})`);
        lines.push(`driver.maximize_window()`);
      } else {
        lines.push('');
        lines.push(`driver.get(${pyStr(step.value)})`);
      }
      first = false;
      continue;
    }
    first = false;

    if (step.type === 'wait') {
      lines.push(`time.sleep(${Number(step.value) / 1000})`);
      continue;
    }
    if (step.type === 'assert') {
      const element = `driver.find_element(${byArgsFor(step.locator)})`;
      if (step.assertion === 'visible') lines.push(`assert ${element}.is_displayed()`);
      else if (step.assertion === 'text') lines.push(`assert ${pyStr(step.expectedText)} in ${element}.text`);
      else lines.push(`${element}  # assert element is present`);
      continue;
    }

    const byArgs = byArgsFor(step.locator);
    if (step.type === 'click') {
      lines.push(`driver.find_element(${byArgs}).click()`);
    } else if (step.type === 'input') {
      const value = step.envVar ? `_required_env(${pyStr(step.envVar)})` : pyValue(step.value);
      lines.push(`driver.find_element(${byArgs}).send_keys(${value})`);
    } else if (step.type === 'select') {
      if (step.multiple) {
        lines.push(`dropdown = Select(driver.find_element(${byArgs}))`);
        lines.push(`dropdown.deselect_all()`);
        if (step.envVar) {
          lines.push(`for value in _required_env(${pyStr(step.envVar)}).split(","):`);
          lines.push(`    dropdown.select_by_visible_text(value.strip())`);
        } else {
          for (const value of (Array.isArray(step.value) ? step.value : [step.value])) {
            lines.push(`dropdown.select_by_visible_text(${pyStr(value)})`);
          }
        }
      } else {
        const value = step.envVar ? `_required_env(${pyStr(step.envVar)})` : pyStr(step.value);
        lines.push(`Select(driver.find_element(${byArgs})).select_by_visible_text(${value})`);
      }
    } else if (step.type === 'keydown') {
      const keyConst = { Enter: 'Keys.ENTER', Tab: 'Keys.TAB', Escape: 'Keys.ESCAPE' }[step.key] || 'Keys.ENTER';
      lines.push(`driver.find_element(${byArgs}).send_keys(${keyConst})`);
    } else if (step.type === 'scroll') {
      if (step.locator) {
        lines.push(`driver.execute_script("arguments[0].scrollTop = arguments[1]; arguments[0].scrollLeft = arguments[2];", driver.find_element(${byArgs}), ${step.scrollY}, ${step.scrollX})`);
      } else {
        lines.push(`driver.execute_script("window.scrollTo(arguments[0], arguments[1]);", ${step.scrollX}, ${step.scrollY})`);
      }
    }
  }

  const importLines = ['from selenium import webdriver', 'from selenium.webdriver.common.by import By'];
  if (usesKeys) importLines.push('from selenium.webdriver.common.keys import Keys');
  if (usesSelect) importLines.push('from selenium.webdriver.support.ui import Select');
  if (usesWait) importLines.push('import time');
  if (usesUnittest) importLines.push('import unittest');
  if (usesPytest) importLines.push('import pytest');
  if (environmentVariables.length) importLines.push('import os');

  const requiredEnvHelper = environmentVariables.length
    ? `\n\ndef _required_env(name):
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Required environment variable {name} is not set. Set it before running, e.g. PowerShell: $env:{name}='value'  |  bash: export {name}='value'")
    return value
`
    : '';

  const primaryBrowser = normalizeBrowsers(config.browsers)[0];

  const tabInit = usesMultipleTabs
    ? `${initialTabId != null ? `tab_handles = {${pyValue(initialTabId)}: driver.current_window_handle}` : 'tab_handles = {}'}\nknown_handles = set(driver.window_handles)`
    : '';
  const script = `# Auto-generated by Selenium Recorder extension.
# Linear automation script — ${config.projectName}
${importLines.join('\n')}
${requiredEnvHelper}

${usesUnittest ? `class RecordedFlow(unittest.TestCase):
    def setUp(self):
${driverCreationLines(primaryBrowser, 'self.driver', '        ')}
        self.driver.maximize_window()
        global driver
        driver = self.driver

    def tearDown(self):
        self.driver.quit()

    def test_recorded_flow(self):
${tabInit.split('\n').map((line) => '        ' + line).join('\n')}
${lines.map((line) => line ? '        ' + line : '').join('\n')}


if __name__ == "__main__":
    unittest.main()
` : usesPytest ? `@pytest.fixture
def driver():
${driverCreationLines(primaryBrowser, 'browser', '    ')}
    browser.maximize_window()
    yield browser
    browser.quit()


def test_recorded_flow(driver):
${tabInit.split('\n').map((line) => '    ' + line).join('\n')}
${lines.map((line) => line ? '    ' + line : '').join('\n')}
` : `${driverCreationLines(primaryBrowser, 'driver', '')}
${tabInit}
${lines.join('\n')}

driver.quit()
`}`;

  return {
    [`tests/test_recorded_flow.py`]: script,
    [`requirements.txt`]: requirementsTxt({ ...config, framework: 'linear' }),
    [`README.md`]: linearReadme(config, environmentVariables)
  };
}

// ---------------------------------------------------------------
// POM generator
// ---------------------------------------------------------------
function buildPOMProject(rawSteps, config) {
  const steps = collapseDuplicates(rawSteps);
  const testDataEntries = assignConfigKeys(steps); // tags each input/select step with step.configKey

  // Group steps into ordered "page visits" by URL path, but accumulate
  // locators/methods per page-key across the whole recording so a page
  // revisited later reuses the same Page/Locators class.
  const pages = new Map(); // pageKey -> { className, locators: [], methods: [], usedMethodNames: Set, usedLocatorNames: Set }
  const flow = []; // ordered list of navigate / wait / action items
  const interactionTabs = new Set();

  let currentUrl = config.baseUrl || (steps.find((s) => s.url)?.url) || 'https://example.com';

  function ensurePage(url, sectionLabel) {
    const moduleKey = moduleKeyFromUrl(url); // e.g. "identity", "gbp_payout_transaction"
    let key, pageSlug;
    if (sectionLabel) {
      // A manually-marked section — not a real URL, so it's keyed
      // separately from URL-derived pages, scoped to the same module.
      pageSlug = slugify(sectionLabel, 'section');
      key = `${moduleKey}::section::${pageSlug}`;
    } else {
      key = pageKeyFromUrl(url);
      pageSlug = pageNameFromUrl(url); // e.g. "login" — short slug for open_<slug>_page()
    }
    if (!pages.has(key)) {
      const baseName = toPascalCase(pageSlug); // e.g. "Login" — drives folder/file names
      pages.set(key, {
        key,
        moduleKey,
        pageSlug,
        baseName,
        isSection: !!sectionLabel, // true => no real URL, so no open_<slug>_page() method
        className: baseName + 'Page', // e.g. "LoginPage" — the Python class name
        locatorClassName: baseName + 'PageLocators', // e.g. "LoginPageLocators"
        actionFolder: baseName + 'Action', // e.g. "LoginAction"
        locatorsFolder: baseName + 'Locators', // e.g. "LoginLocators"
        locators: [],
        methods: [],
        usedMethodNames: new Set(),
        usedLocatorNames: new Set()
      });
    }
    return pages.get(key);
  }

  let currentSectionLabel = null;
  for (const step of steps) {
    if (step.url) currentUrl = step.url;
    if (isInteractionType(step.type)) interactionTabs.add(tabKey(step.tabId));

    if (step.type === 'tab_open') {
      if (interactionTabs.has(tabKey(step.openerTabId))) interactionTabs.add(tabKey(step.tabId));
      flow.push({ kind: 'tab_open', tabId: step.tabId, openerTabId: step.openerTabId });
      continue;
    }
    if (step.type === 'tab_switch') {
      flow.push({ kind: 'tab_switch', tabId: step.tabId, fromTabId: step.fromTabId });
      continue;
    }
    if (step.type === 'navigate') {
      currentSectionLabel = null; // a real navigation supersedes any manual section marker
      const navigationTabKey = tabKey(step.tabId);
      const followsInteraction = interactionTabs.has(navigationTabKey);
      interactionTabs.delete(navigationTabKey);
      flow.push({ kind: 'navigate', url: step.value, tabId: step.tabId, followsInteraction });
      continue;
    }
    if (step.type === 'wait') {
      flow.push({ kind: 'wait', ms: Number.isFinite(Number(step.value)) ? Number(step.value) : 1000 });
      continue;
    }
    if (step.type === 'section') {
      currentSectionLabel = step.label || step.description || null;
      if (!currentSectionLabel) continue;
      const sectionPage = ensurePage(currentUrl, currentSectionLabel);
      flow.push({ kind: 'section', pageKey: sectionPage.key });
      continue;
    }

    const page = ensurePage(currentUrl, currentSectionLabel);
    const methodName = methodNameFor(step, page.usedMethodNames);
    const locatorName = step.locator ? locatorNameFor(step, page.usedLocatorNames) : null;
    const byTuple = byTupleFor(step.locator);

    if (step.locator) page.locators.push({ name: locatorName, byTuple, comment: cleanComment(step.description, 200) });
    const method = { methodName, locatorName, step };
    page.methods.push(method);

    flow.push({ kind: 'action', pageKey: page.key, className: page.className, methodName, method, arg: methodArgFor(step), comment: describeStepComment(step), tabId: step.tabId });
  }

  // The very first navigation (if any) is folded into the fixture as
  // `<firstPage>.open_<slug>_page(Config.BASE_URL)` instead of appearing
  // as a step in the test body — mirrors opening the entry page once
  // per browser session.
  let firstPageKey = null;
  if (flow.length && flow[0].kind === 'navigate') {
    const key = pageKeyFromUrl(flow[0].url);
    if ([...pages.keys()].includes(key) || pages.size === 0) {
      firstPageKey = pageKeyFromUrl(flow[0].url);
      flow.shift();
    }
  }
  const baseUrl = findBaseUrl(steps, config);

  const files = {};

  files[`config/__init__.py`] = '';
  files[`config/config.py`] = configPy(config, baseUrl, testDataEntries);
  files[`requirements.txt`] = requirementsTxt(config);
  files[`README.md`] = pomReadme(config, pages, testDataEntries);
  if (config.testRunner !== 'unittest') {
    files[`pytest.ini`] = pytestIni(config);
    files[`conftest.py`] = rootConftest(config.projectName);
    files[`report_logo.py`] = reportLogoPy();
  }
  files[`LICENSE`] = licenseText(config);
  files[`healed_locators.json`] = healedLocatorsJson();
  if (config.testRunner !== 'unittest') files[`.github/workflows/tests.yml`] = githubWorkflow(config);
  files[`assets/.gitkeep`] = '';
  if (config.screenshots !== false) files[`screenshots/.gitkeep`] = '';

  const moduleKeysSeen = new Set();
  for (const page of pages.values()) {
    if (!moduleKeysSeen.has(page.moduleKey)) {
      files[`${page.moduleKey}/__init__.py`] = '';
      moduleKeysSeen.add(page.moduleKey);
    }
    files[`${page.moduleKey}/${page.actionFolder}/__init__.py`] = '';
    files[`${page.moduleKey}/${page.locatorsFolder}/__init__.py`] = '';
    files[`${page.moduleKey}/${page.actionFolder}/${lowerFirst(page.className)}.py`] = pageActionFile(page, config);
    files[`${page.moduleKey}/${page.locatorsFolder}/${lowerFirst(page.baseName)}Locators.py`] = pageLocatorsFile(page);
  }

  files[`tests/test_${slugify(config.projectName, 'recorded_flow')}.py`] = testFile(flow, pages, config, firstPageKey);

  return files;
}

function pageLocatorsFile(page) {
  const lines = page.locators.map((l) => `    # ${l.comment}\n    ${l.name} = ${l.byTuple}`).join('\n\n');
  return `"""
Locators for ${page.className}.
Auto-generated by Selenium Recorder extension — edit freely, this file
is not overwritten unless you re-export the whole project.
"""
from selenium.webdriver.common.by import By


class ${page.locatorClassName}:
${lines || '    pass'}
`;
}

// Builds one try/except block matching the reference style: specific
// Selenium exceptions get a descriptive log line, a screenshot, then
// re-raise; anything else is caught by a broader handler doing the same.
function wrapWithErrorHandling({
  tryLines,
  actionLabel,
  failureMessage: baseFailureMessage,
  unexpectedErrorMessage,
  actionName,
  config
}) {
  const logging = config.logging !== false;
  const screenshotLine = config.screenshots !== false ? `            self._take_screenshot(${pyStr(actionName)})\n` : '';
  const successLog = logging ? `            self.logger.info(${actionLabel})` : '';
  const specificLog = logging ? `            self.logger.error(f"${baseFailureMessage} - {e}")\n` : '';
  const genericLog = logging ? `            self.logger.error(f"${unexpectedErrorMessage} - {e}")\n` : '';
  return `        try:
${tryLines.map((l) => '            ' + l).join('\n')}
${successLog}
        except (TimeoutException, ElementClickInterceptedException,
                NoSuchElementException, StaleElementReferenceException) as e:
${specificLog}${screenshotLine}            raise
        except Exception as e:
${genericLog}${screenshotLine}            raise`;
}

function pageActionFile(page, config) {
  const methodsCode = page.methods
    .map((m) => {
      const step = m.step;
      const locRef = `${page.locatorClassName}.${m.locatorName}`;
      const target = cleanLabel(step.description || step.elementType || 'element')
        .replace(/\{/g, '{{')
        .replace(/\}/g, '}}');
      const failureContext = {
        click: { failure: `${target} not clickable within {Config.DEFAULT_TIMEOUT} seconds`, unexpected: `Unexpected error clicking ${target}` },
        input: { failure: `${target} field not reachable within {Config.DEFAULT_TIMEOUT} seconds`, unexpected: `Unexpected error entering ${target}` },
        select: { failure: `${target} dropdown not reachable within {Config.DEFAULT_TIMEOUT} seconds`, unexpected: `Unexpected error selecting ${target}` },
        keydown: { failure: `${target} not reachable within {Config.DEFAULT_TIMEOUT} seconds`, unexpected: `Unexpected error pressing ${step.key} on ${target}` },
        scroll: { failure: `${target} not reachable within {Config.DEFAULT_TIMEOUT} seconds`, unexpected: `Unexpected error scrolling ${target}` },
        assert: { failure: `${target} did not satisfy the ${step.assertion} check within {Config.DEFAULT_TIMEOUT} seconds`, unexpected: `Unexpected error checking ${target}` }
      }[step.type] || { failure: `${target} not reachable within {Config.DEFAULT_TIMEOUT} seconds`, unexpected: `Unexpected error performing ${target}` };

      if (step.type === 'click') {
        const body = wrapWithErrorHandling({
          tryLines: [`element = self.wait.until(EC.element_to_be_clickable(${locRef}))`, 'element.click()'],
          actionLabel: pyStr(`Clicked "${collapseWhitespace(step.description)}"`),
          failureMessage: failureContext.failure,
          unexpectedErrorMessage: failureContext.unexpected,
          actionName: m.methodName,
          config
        });
        return `    def ${m.methodName}(self):
        """Click "${cleanLabel(step.description)}"."""
${body}`;
      }

      if (step.type === 'input') {
        const body = wrapWithErrorHandling({
          tryLines: step.elementType === 'contenteditable'
            ? ['field = self.wait.until(EC.presence_of_element_located(' + locRef + '))', 'field.click()', 'field.send_keys(Keys.CONTROL, "a")', 'field.send_keys(value)']
            : ['field = self.wait.until(EC.presence_of_element_located(' + locRef + '))', 'field.clear()', 'field.send_keys(value)'],
          actionLabel: pyStr(`Entered value into "${collapseWhitespace(step.description)}"`),
          failureMessage: failureContext.failure,
          unexpectedErrorMessage: failureContext.unexpected,
          actionName: m.methodName,
          config
        });
        // Fields whose value now lives in Config never get the recorded
        // value baked in as a default — the caller passes Config.<KEY>
        // explicitly instead (see assignConfigKeys / methodArgFor).
        const signature = step.configKey ? `self, value` : `self, value=${pyValue(step.value)}`;
        return `    def ${m.methodName}(${signature}):
        """Type text into "${cleanLabel(step.description)}"."""
${body}`;
      }

      if (step.type === 'select') {
        const body = wrapWithErrorHandling({
          tryLines: step.multiple
            ? ['dropdown = Select(self.wait.until(EC.presence_of_element_located(' + locRef + ')))', 'dropdown.deselect_all()', 'for option in option_texts:', '    dropdown.select_by_visible_text(option)']
            : ['dropdown = self.wait.until(EC.presence_of_element_located(' + locRef + '))', 'Select(dropdown).select_by_visible_text(option_text)'],
          actionLabel: pyStr(`Selected option in "${collapseWhitespace(step.description)}"`),
          failureMessage: failureContext.failure,
          unexpectedErrorMessage: failureContext.unexpected,
          actionName: m.methodName,
          config
        });
        const signature = step.multiple
          ? (step.configKey ? 'self, option_texts' : `self, option_texts=${pyValue(step.value)}`)
          : (step.configKey ? 'self, option_text' : `self, option_text=${pyValue(step.value)}`);
        return `    def ${m.methodName}(${signature}):
        """Select an option in "${cleanLabel(step.description)}"."""
${body}`;
      }

      if (step.type === 'keydown') {
        const keyConst = { Enter: 'Keys.ENTER', Tab: 'Keys.TAB', Escape: 'Keys.ESCAPE' }[step.key] || 'Keys.ENTER';
        const body = wrapWithErrorHandling({
          tryLines: ['element = self.wait.until(EC.presence_of_element_located(' + locRef + '))', `element.send_keys(${keyConst})`],
          actionLabel: pyStr(`Pressed ${step.key} on "${collapseWhitespace(step.description)}"`),
          failureMessage: failureContext.failure,
          unexpectedErrorMessage: failureContext.unexpected,
          actionName: m.methodName,
          config
        });
        return `    def ${m.methodName}(self):
        """Press ${step.key} on "${cleanLabel(step.description)}"."""
${body}`;
      }

      if (step.type === 'scroll') {
        if (step.locator) {
          const body = wrapWithErrorHandling({
            tryLines: [
              `element = self.wait.until(EC.presence_of_element_located(${locRef}))`,
              `self.driver.execute_script("arguments[0].scrollTop = arguments[1]; arguments[0].scrollLeft = arguments[2];", element, ${step.scrollY}, ${step.scrollX})`
            ],
            actionLabel: pyStr(`Scrolled "${collapseWhitespace(step.description)}" ${step.direction || ''}`.trim()),
            failureMessage: failureContext.failure,
            unexpectedErrorMessage: failureContext.unexpected,
            actionName: m.methodName,
            config
          });
          return `    def ${m.methodName}(self):
        """Scroll "${cleanLabel(step.description)}" ${step.direction || ''} to (${step.scrollX}, ${step.scrollY})."""
${body}`;
        }
        const body = wrapWithErrorHandling({
          tryLines: [`self.driver.execute_script("window.scrollTo(arguments[0], arguments[1]);", ${step.scrollX}, ${step.scrollY})`],
          actionLabel: pyStr(`Scrolled page ${step.direction || ''}`.trim()),
          failureMessage: failureContext.failure,
          unexpectedErrorMessage: failureContext.unexpected,
          actionName: m.methodName,
          config
        });
        return `    def ${m.methodName}(self):
        """Scroll the page ${step.direction || ''} to (${step.scrollX}, ${step.scrollY})."""
${body}`;
      }

      if (step.type === 'assert') {
        const waitCondition = step.assertion === 'visible'
          ? `self.wait.until(EC.visibility_of_element_located(${locRef}))`
          : `self.wait.until(EC.presence_of_element_located(${locRef}))`;
        const tryLines = [ `element = ${waitCondition}` ];
        if (step.assertion === 'text') {
          tryLines.push(`self.wait.until(EC.text_to_be_present_in_element(${locRef}, ${pyStr(step.expectedText)}))`);
        }
        const body = wrapWithErrorHandling({
          tryLines,
          actionLabel: pyStr(`Asserted ${step.assertion} for "${collapseWhitespace(step.description)}"`),
          failureMessage: failureContext.failure,
          unexpectedErrorMessage: failureContext.unexpected,
          actionName: m.methodName,
          config
        });
        return `    def ${m.methodName}(self):
        """Assert ${step.assertion} for "${cleanLabel(step.description)}"."""
${body}`;
      }

      return `    def ${m.methodName}(self):
        pass`;
    })
    .join('\n\n');

  const openMethod = page.isSection
    ? ''
    : `    def open_${page.pageSlug}_page(self, url):
        """Navigate to the ${page.pageSlug} page."""
        try:
            self.driver.get(url)
${config.logging !== false ? '            self.logger.info(f"Opened page: {url}")' : '            pass'}
        except Exception as e:
${config.logging !== false ? '            self.logger.error(f"Failed to open page: {url} - {e}")' : '            pass'}
${config.screenshots !== false ? `            self._take_screenshot("open_${page.pageSlug}_page")` : '            pass'}
            raise`;

  const screenshotMethod = config.screenshots === false ? '' : `    def _take_screenshot(self, action_name):
        timestamp = int(time.time())
        screenshots_dir = Path(__file__).resolve().parents[2] / "screenshots"
        screenshots_dir.mkdir(parents=True, exist_ok=True)
        screenshot_path = str(screenshots_dir / f"{action_name}_{timestamp}.png")
        try:
            self.driver.save_screenshot(screenshot_path)
            self.logger.info(f"Screenshot saved: {screenshot_path}")
        except Exception as screenshot_error:
${config.logging !== false ? '            self.logger.warning(f"Failed to capture screenshot: {screenshot_error}")' : '            warnings.warn(f"Failed to capture screenshot: {screenshot_error}", RuntimeWarning)'}`;

  return `"""
Page actions for ${page.className}.
Auto-generated by Selenium Recorder extension.
"""
import time
${config.logging !== false ? 'import logging' : ''}
${config.screenshots !== false && config.logging === false ? 'import warnings' : ''}
from pathlib import Path
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait, Select
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import (
    TimeoutException,
    ElementClickInterceptedException,
    NoSuchElementException,
    StaleElementReferenceException,
)

from ${page.moduleKey}.${page.locatorsFolder}.${lowerFirst(page.baseName)}Locators import ${page.locatorClassName}
from config.config import Config


class ${page.className}:
    def __init__(self, driver):
        self.driver = driver
        self.wait = WebDriverWait(driver, Config.DEFAULT_TIMEOUT)
${config.logging !== false ? '        self.logger = logging.getLogger(__name__)' : ''}

${openMethod}

${methodsCode || '    pass'}

${screenshotMethod}
`;
}

function testFile(flow, pages, config, firstPageKey) {
  if (config.testRunner === 'unittest') return testFileUnittest(flow, pages, config, firstPageKey);
  const pageList = Array.from(pages.values());
  const pageImports = pageList.map((p) => `from ${p.moduleKey}.${p.actionFolder}.${lowerFirst(p.className)} import ${p.className}`).join('\n');

  const firstPage = firstPageKey ? pages.get(firstPageKey) : null;
  const browserImports = browserImportLines(config.browsers);
  const fixture = driverSetupFixture(config.browsers);
  const projectSlug = slugify(config.projectName, 'recorded_flow');
  const usesMultipleTabs = flow.some((item) => item.kind === 'tab_open' || item.kind === 'tab_switch');

  // The entry fixture opens the first page; one test function then
  // executes the complete flow against that shared browser session.
  const entryFixtureName = firstPage ? firstPage.pageSlug : 'session';
  const entryLocalVar = firstPage ? `${firstPage.pageSlug}_page` : 'page';
  const entryOpenLine = firstPage ? `    ${entryLocalVar}.open_${firstPage.pageSlug}_page(Config.BASE_URL)` : '';
  const entryClassLine = firstPage ? `    ${entryLocalVar} = ${firstPage.className}(driver)` : '';
  const entryReturnExpr = firstPage ? entryLocalVar : 'driver';
  const pageVars = new Map();
  const usedPageVars = new Set();
  if (firstPage) {
    pageVars.set(firstPage.key, entryFixtureName);
    usedPageVars.add(entryFixtureName);
  }
  function ensurePageVar(page, lines) {
    if (pageVars.has(page.key)) return pageVars.get(page.key);
    const variable = uniqueName(`${page.pageSlug}_page`, usedPageVars);
    pageVars.set(page.key, variable);
    lines.push(`    ${variable} = ${page.className}(driver)`);
    return variable;
  }
  function bodyForItems(items) {
    const lines = [];
    for (const item of items) {
      if (item.kind === 'wait') {
        lines.push(`    time.sleep(${item.ms / 1000})  # explicit wait requested during recording`);
        lines.push('');
      } else if (item.kind === 'navigate') {
        if (item.followsInteraction) continue;
        const page = pages.get(pageKeyFromUrl(item.url));
        if (usesMultipleTabs && item.tabId != null) lines.push(`    driver.switch_to.window(tab_handles[${pyValue(item.tabId)}])`);
        if (page) {
          const pageVar = ensurePageVar(page, lines);
          lines.push(`    ${pageVar}.open_${page.pageSlug}_page(${pyStr(item.url)})`);
        } else {
          lines.push(`    driver.get(${pyStr(item.url)})`);
        }
      } else if (item.kind === 'tab_open') {
        lines.push('    new_handles = [h for h in driver.window_handles if h not in known_handles]');
        lines.push('    if new_handles:');
        lines.push('        driver.switch_to.window(new_handles[-1])');
        lines.push('    else:');
        lines.push('        driver.switch_to.new_window("tab")');
        lines.push(`    tab_handles[${pyValue(item.tabId)}] = driver.current_window_handle`);
        lines.push('    known_handles = set(driver.window_handles)');
        lines.push('');
      } else if (item.kind === 'tab_switch') {
        lines.push(`    driver.switch_to.window(tab_handles[${pyValue(item.tabId)}])`);
        lines.push('');
      } else if (item.kind === 'action') {
        const page = pages.get(item.pageKey);
        const pageVar = ensurePageVar(page, lines);
        const call = item.arg != null ? `${item.methodName}(${item.arg})` : `${item.methodName}()`;
        lines.push(`    # ${item.comment}`);
        lines.push(`    ${pageVar}.${call}`);
        lines.push('');
      }
    }
    return lines.join('\n');
  }

  const testName = `test_${firstPage ? firstPage.pageSlug + '_page' : 'recorded_flow'}_on_${projectSlug}`;
  const driverLine = firstPage ? `    driver = ${entryFixtureName}.driver` : `    driver = ${entryFixtureName}`;
  const initialTabMap = usesMultipleTabs && config.initialTabId != null
    ? `    tab_handles = {${pyValue(config.initialTabId)}: driver.current_window_handle}`
    : (usesMultipleTabs ? '    tab_handles = {}' : '');
  const knownHandles = usesMultipleTabs ? '    known_handles = set(driver.window_handles)\n' : '';
  const body = bodyForItems(flow) || '    pass';
  const testFunction = `def ${testName}(${entryFixtureName}):
${driverLine}
${initialTabMap}
${knownHandles.trimEnd()}
${body}`;

  return `"""
Auto-generated by Selenium Recorder extension.
Page Object Model Pytest + Selenium test.
Project: ${config.projectName}
The complete recorded flow runs in order in a single test function using
the "${entryFixtureName}" fixture.
"""
import time
import pytest
from selenium import webdriver
${browserImports}

from config.config import Config
${pageImports}


${fixture}


@pytest.fixture(scope="module")
def ${entryFixtureName}(driver_setup):
    driver = driver_setup
${entryClassLine}
${entryOpenLine}
    return ${entryReturnExpr}


${testFunction}
`;
}

function testFileUnittest(flow, pages, config, firstPageKey) {
  const firstPage = firstPageKey ? pages.get(firstPageKey) : null;
  const usesMultipleTabs = flow.some((item) => item.kind === 'tab_open' || item.kind === 'tab_switch');
  const imports = Array.from(pages.values())
    .map((page) => `from ${page.moduleKey}.${page.actionFolder}.${lowerFirst(page.className)} import ${page.className}`)
    .join('\n');
  const initialTab = usesMultipleTabs && config.initialTabId != null
    ? `{${pyValue(config.initialTabId)}: cls.driver.current_window_handle}`
    : (usesMultipleTabs ? '{}' : '');
  const setupPage = firstPage
    ? `        cls.entry_page = ${firstPage.className}(cls.driver)\n        cls.entry_page.open_${firstPage.pageSlug}_page(Config.BASE_URL)`
    : '';
  const emitted = [];
  if (usesMultipleTabs) {
    emitted.push('        tab_handles = self.tab_handles');
    emitted.push('        known_handles = set(self.driver.window_handles)');
  }
  emitted.push('        page_objects = {}');

  for (const item of flow) {
    if (item.kind === 'wait') {
      emitted.push(`        time.sleep(${item.ms / 1000})`);
    } else if (item.kind === 'tab_open') {
      emitted.push('        new_handles = [h for h in self.driver.window_handles if h not in known_handles]');
      emitted.push('        if new_handles:');
      emitted.push('            self.driver.switch_to.window(new_handles[-1])');
      emitted.push('        else:');
      emitted.push('            self.driver.switch_to.new_window("tab")');
      emitted.push(`        tab_handles[${pyValue(item.tabId)}] = self.driver.current_window_handle`);
      emitted.push('        known_handles = set(self.driver.window_handles)');
    } else if (item.kind === 'tab_switch') {
      emitted.push(`        self.driver.switch_to.window(tab_handles[${pyValue(item.tabId)}])`);
    } else if (item.kind === 'navigate') {
      if (item.followsInteraction) continue;
      if (usesMultipleTabs && item.tabId != null) emitted.push(`        self.driver.switch_to.window(tab_handles[${pyValue(item.tabId)}])`);
      const page = pages.get(pageKeyFromUrl(item.url));
      if (page) {
        emitted.push(`        page_objects[${pyStr(page.key)}] = ${page.className}(self.driver)`);
        emitted.push(`        page_objects[${pyStr(page.key)}].open_${page.pageSlug}_page(${pyStr(item.url)})`);
      } else {
        emitted.push(`        self.driver.get(${pyStr(item.url)})`);
      }
    } else if (item.kind === 'action') {
      const page = pages.get(item.pageKey);
      if (!page) continue;
      const pageKey = pyStr(page.key);
      emitted.push(`        if ${pageKey} not in page_objects:`);
      emitted.push(`            page_objects[${pageKey}] = ${page.className}(self.driver)`);
      const call = item.arg != null ? `${item.methodName}(${item.arg})` : `${item.methodName}()`;
      emitted.push(`        page_objects[${pageKey}].${call}`);
    }
  }
  const browser = normalizeBrowsers(config.browsers)[0];

  return `"""
Auto-generated Selenium Page Object Model tests using unittest.
Project: ${config.projectName}
"""
import time
import unittest
from selenium import webdriver
from config.config import Config
${imports}


class RecordedFlowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
${driverCreationLines(browser, 'cls.driver', '        ')}
        cls.driver.maximize_window()
${usesMultipleTabs ? `        cls.tab_handles = ${initialTab}\n` : ''}${setupPage}

    @classmethod
    def tearDownClass(cls):
        cls.driver.quit()

    def test_recorded_flow(self):
${emitted.join('\n')}


if __name__ == "__main__":
    unittest.main()
`;
}

function configPy(config, baseUrl, testDataEntries) {
  const entries = testDataEntries || [];
  const environmentEntries = entries.filter((entry) => entry.envVar);
  const dataLines = entries.map((entry) => entry.envVar
    ? `    ${entry.key} = _required_env(${pyStr(entry.envVar)})`
    : `    ${entry.key} = ${pyValue(entry.value)}`);
  const environmentHelper = environmentEntries.length
    ? `import os


def _required_env(name):
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Required environment variable {name} is not set. Set it before running, e.g. PowerShell: $env:{name}='value'  |  bash: export {name}='value'")
    return value

`
    : '';

  return `"""
Project-level configuration.
"""
import random
${environmentHelper}


class Config:
    PROJECT_NAME = ${pyStr(config.projectName)}
    BASE_URL = ${pyStr(baseUrl)}
${dataLines.length ? dataLines.join('\n') + '\n' : ''}    DEFAULT_TIMEOUT = 20
`;
}

function pytestIni(config) {
  if (config.logging === false) {
    return `[pytest]
; Self-contained HTML report generated for each run.
addopts = --html=report.html --self-contained-html
`;
  }
  return `[pytest]
; Persists every self.logger call (info/error) from the Page Action
; classes to automation.log, so a long or multi-browser test run
; leaves a reviewable trail even after the terminal output has scrolled
; away. Screenshots referenced in ERROR lines live in screenshots/.
log_file = automation.log
log_file_level = INFO
log_file_format = %(asctime)s [%(levelname)s] %(name)s: %(message)s
log_file_date_format = %Y-%m-%d %H:%M:%S
; Also generates a self-contained HTML test report at report.html on
; every run (requires pytest-html, see requirements.txt).
addopts = --html=report.html --self-contained-html
`;
}

function reportLogoPy() {
  const chunks = CONFIXHUB_LOGO_DATA.match(/.{1,100}/g) || [];
  return `"""Default logo shown in report.html (base64 PNG). Put your own image at
assets/logo.png (or .svg/.jpg/.webp) to override it, or delete this file for a text header."""

LOGO_BASE64 = (
${chunks.map((c) => `    "${c}"`).join('\n')}
)
`;
}

function rootConftest(projectName) {
  return `"""
Sits at the project root so pytest adds this directory to sys.path —
without it, running the bare \`pytest\` command (as opposed to
\`python -m pytest\`) fails with "ModuleNotFoundError: No module named
'config'" because nothing anchors the project root onto the import
path. Adds a styled QA dashboard to report.html through pytest-html hooks.
"""

import base64
import mimetypes
import platform
import sys
import time
from datetime import datetime
from html import escape
from pathlib import Path

import pytest


_results = {"passed": 0, "failed": 0, "skipped": 0, "error": 0}
_session_started_at = None
_project_name = ${pyStr(projectName)}


def pytest_html_report_title(report):
    report.title = f"{_project_name} — QA Test Report"


def pytest_sessionstart(session):
    global _session_started_at
    for key in _results:
        _results[key] = 0
    _session_started_at = time.perf_counter()


def pytest_runtest_logreport(report):
    if report.when == "setup" and report.outcome == "failed":
        _results["error"] += 1
    elif report.when == "setup" and report.outcome == "skipped":
        _results["skipped"] += 1
    elif report.when == "teardown" and report.outcome == "failed":
        _results["error"] += 1
    elif report.when == "call" and report.outcome in _results:
        _results[report.outcome] += 1


def pytest_collectreport(report):
    if report.failed:
        _results["error"] += 1


_BRAND = "CONFIXHUB"
_TAGLINE = "TRAIN · TEST · SECURE · GROW"

_STYLE = """
<style>
#title, #environment-header, #environment, body > p:first-of-type, .summary__data > h2, .summary__data > p { display: none; }
body { background: #f6f9fc; color: #102a46; font-family: "Segoe UI", Arial, sans-serif; }
#results-table { border-collapse: separate; border-spacing: 0; width: 100%; background: #fff; border: 1px solid #dce5ef; border-radius: 10px; overflow: hidden; }
#results-table th { background: #f1f5fa; color: #3d5670; text-align: left; padding: 11px 14px; border-bottom: 1px solid #dce5ef; }
#results-table td { padding: 11px 14px; border-bottom: 1px solid #eef2f7; }
.collapsible td.col-result { font-weight: 700; }
tr.failed td, tr.error td { background: #fff1f1; }
tr.passed td { background: #fff; }
.log { background: #1f2933 !important; color: #e6edf3 !important; border-radius: 8px; padding: 14px 16px !important; font-family: Consolas, monospace; font-size: 12.5px; line-height: 1.55; }
.log .error, .log .E { color: #ff6b6b; }
.qa-card { flex: 1 1 150px; display: flex; align-items: center; gap: 14px; padding: 16px; border: 1px solid #dce5ef; border-radius: 10px; }
.qa-icon { width: 42px; height: 42px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 20px; font-weight: 700; flex-shrink: 0; }
.qa-env { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 18px; font-size: 13px; color: #3d5670; }
.qa-env small { display: block; color: #0788a8; font-weight: 700; margin-bottom: 5px; }
.qa-env ul { margin: 0; padding-left: 18px; }
</style>
"""


def _versions(config):
    try:
        from pytest_metadata.plugin import metadata_key
        meta = config.stash[metadata_key]
    except Exception:
        meta = {}
    return meta.get("Packages") or {"pytest": pytest.__version__}, meta.get("Plugins") or {}


def _brand_html():
    # Drop a logo at assets/logo.png (or .svg/.jpg/.webp) to show it in the report header.
    for name in ("logo.png", "logo.svg", "logo.jpg", "logo.jpeg", "logo.webp"):
        path = Path(__file__).parent / "assets" / name
        if path.is_file():
            mime = mimetypes.guess_type(name)[0] or "image/png"
            data = base64.b64encode(path.read_bytes()).decode("ascii")
            return f'<img alt="{escape(_BRAND)}" src="data:{mime};base64,{data}" style="height:62px;display:block;mix-blend-mode:multiply;">'
    try:
        from report_logo import LOGO_BASE64
        return (f'<img alt="{escape(_BRAND)}" src="data:image/png;base64,{LOGO_BASE64}" '
                'style="height:62px;display:block;mix-blend-mode:multiply;">')
    except ImportError:
        pass
    return (f'<div style="font-size:30px;font-weight:800;color:#102a46;letter-spacing:.5px;">{escape(_BRAND)}</div>'
            f'<div style="font-size:11px;letter-spacing:2px;color:#4b647d;">{escape(_TAGLINE)}</div>')


_COPY_SCRIPT = """
<script>
(function () {
  function addCopyButtons() {
    document.querySelectorAll('.log').forEach(function (log) {
      if (log.dataset.qaCopy || /^\s*No log output captured/.test(log.textContent)) return;
      log.dataset.qaCopy = '1';
      var bar = document.createElement('div');
      bar.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin:0 0 8px;color:#fff;font:700 14px Segoe UI,Arial,sans-serif;';
      bar.innerHTML = '<span>Error Details</span>';
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Copy';
      button.style.cssText = 'cursor:pointer;border:1px solid #cbd5e1;background:#fff;color:#102a46;border-radius:6px;padding:4px 14px;font-weight:600;position:relative;z-index:5;';
      button.onclick = function () {
        var text = log.dataset.qaText;
        var done = function () { button.textContent = 'Copied'; setTimeout(function () { button.textContent = 'Copy'; }, 1500); };
        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.writeText(text).then(done);
        } else {
          var area = document.createElement('textarea');
          area.value = text;
          document.body.appendChild(area);
          area.select();
          document.execCommand('copy');
          document.body.removeChild(area);
          done();
        }
      };
      log.dataset.qaText = log.textContent;
      bar.appendChild(button);
      log.insertBefore(bar, log.firstChild);
    });
  }
  new MutationObserver(addCopyButtons).observe(document.documentElement, {childList: true, subtree: true});
  document.addEventListener('DOMContentLoaded', addCopyButtons);
})();
</script>
"""


def _list_html(items):
    if not items:
        return "<ul><li>None</li></ul>"
    return "<ul>" + "".join(f"<li>{escape(str(k))}: {escape(str(v))}</li>" for k, v in items.items()) + "</ul>"


def pytest_html_results_summary(prefix, summary, postfix, session):
    total_tests = session.testscollected
    duration_ms = round((time.perf_counter() - _session_started_at) * 1000) if _session_started_at else 0
    status = (
        "ERROR" if _results["error"]
        else "FAILED" if _results["failed"]
        else "NO TESTS" if total_tests == 0
        else "SKIPPED" if _results["skipped"] == total_tests
        else "PASSED"
    )
    status_color, status_bg = {
        "ERROR": ("#dc2626", "#fde8e8"),
        "FAILED": ("#dc2626", "#fde8e8"),
        "SKIPPED": ("#d97706", "#fff4df"),
        "NO TESTS": ("#64748b", "#eef1f5"),
    }.get(status, ("#059669", "#e5f7ef"))
    cards = [
        ("Total Tests", total_tests, "▤", "#64748b", "#f4f6f9", "#102a46"),
        ("Passed", _results["passed"], "✓", "#16a34a", "#e9f9f1", "#102a46"),
        ("Failed", _results["failed"], "✕", "#ef4444", "#fff0f0", "#dc2626" if _results["failed"] else "#102a46"),
        ("Errors", _results["error"], "!", "#f97316", "#fff6e5", "#dc2626" if _results["error"] else "#102a46"),
        ("Skipped", _results["skipped"], "–", "#94a3b8", "#f1f4f8", "#102a46"),
        ("Duration", f"{duration_ms} ms", "◷", "#2563eb", "#edf4ff", "#102a46"),
    ]
    card_html = "".join(
        f'<div class="qa-card" style="background:{bg};">'
        f'<div class="qa-icon" style="background:{color};">{icon}</div>'
        f'<div><div style="font-size:13px;color:#4b647d;">{label}</div>'
        f'<strong style="font-size:26px;color:{value_color};">{value}</strong></div></div>'
        for label, value, icon, color, bg, value_color in cards
    )
    packages, plugins = _versions(session.config)
    try:
        from importlib.metadata import version
        html_version = version("pytest-html")
    except Exception:
        html_version = "unknown"
    generated = datetime.now().strftime("%d-%b-%Y at %H:%M:%S")
    prefix.append(
        _STYLE + _COPY_SCRIPT +
        '<div style="margin:0 0 22px;">'
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;'
        'padding:18px 24px;background:#f4f8fc;border-bottom:1px solid #dce5ef;">'
        f'<div>{_brand_html()}</div>'
        '<div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap;">'
        f'<div style="font-size:12px;color:#4b647d;"><b style="font-size:15px;color:#102a46;">report.html</b><br>'
        f'Generated on {generated}<br>by pytest-html v{escape(html_version)}</div>'
        f'<div style="padding:12px 20px;border-radius:10px;background:{status_bg};color:{status_color};">'
        f'<small>Report Status</small><div style="font-size:22px;font-weight:800;">{status}</div></div>'
        '</div></div>'
        '<div style="padding:18px 4px 0;">'
        f'<h1 style="margin:0;font-size:36px;color:#102a46;">QA Test Report</h1>'
        f'<div style="font-size:17px;color:#4b647d;">Automated Test Execution Report &middot; {escape(_project_name)}</div>'
        '<div style="height:3px;margin-top:10px;background:#e3e9f0;"><div style="width:120px;height:3px;background:#16a34a;"></div></div></div>'
        f'<div style="display:flex;flex-wrap:wrap;gap:12px;padding:18px 0;">{card_html}</div>'
        '<div style="padding:16px 20px;border:1px solid #dce5ef;border-radius:10px;background:#fff;">'
        '<h2 style="margin:0 0 14px;font-size:19px;">Environment</h2>'
        '<div class="qa-env">'
        f'<div><small>Python</small><b>{escape(sys.version.split()[0])}</b></div>'
        f'<div><small>Platform</small><b>{escape(platform.platform())}</b></div>'
        f'<div><small>Packages</small>{_list_html(packages)}</div>'
        f'<div><small>Plugins</small>{_list_html(plugins)}</div>'
        '</div></div>'
        '<h2 style="margin:22px 0 4px;font-size:19px;">Test Results</h2>'
        '</div>'
    )
`;
}

function licenseText(config) {
  const year = new Date().getFullYear();
  return `MIT License

Copyright (c) ${year} ${config.projectName}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
}

function healedLocatorsJson() {
  return (
    JSON.stringify(
      {
        _note: 'Reserved for a future self-healing-locator feature. Empty by default — the recorder does not currently auto-heal broken locators.'
      },
      null,
      2
    ) + '\n'
  );
}

function githubWorkflow(config) {
  const browserSetup = normalizeBrowsers(config.browsers).map((browser) => {
    const names = { chrome: 'Chrome', edge: 'Edge', firefox: 'Firefox' };
    return `      - name: Install ${names[browser]}
        uses: browser-actions/setup-${browser}@v1`;
  }).join('\n');
  return `name: Tests

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - name: Install dependencies
        run: pip install -r requirements.txt
${browserSetup}
      - name: Run ${config.projectName} test suite
        run: pytest tests/ -v
${config.screenshots === false ? '' : `      - name: Upload failure screenshots
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: screenshots
          path: screenshots/\n`}${config.logging === false ? '' : `      - name: Upload log
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: automation-log
          path: automation.log\n`}
`;
}

function requirementsTxt(config = {}) {
  const lines = ['selenium>=4.15.0', 'webdriver-manager>=4.0.0'];
  const isLinear = config.framework === 'linear';
  const runner = config.testRunner || (isLinear ? 'script' : 'pytest');
  if (runner === 'pytest') {
    lines.push('pytest>=7.4.0');
    if (!isLinear) lines.push('pytest-html>=4.1.0');
  }
  return lines.join('\n') + '\n';
}

function environmentSetupNote(entries) {
  if (!entries.length) return '';
  const variables = entries.map((entry) => entry.envVar);
  return `## Sensitive test data

Fields marked secret are not written into the generated source. Set
these environment variables before running tests:

\`\`\`powershell
${variables.map((name) => `$env:${name} = "your-value"`).join('\n')}
\`\`\`

\`\`\`bash
${variables.map((name) => `export ${name}="your-value"`).join('\n')}
\`\`\`
The recorder keeps captured values in Chrome's local extension storage
for replay. Secret masking applies to the popup and generated project;
it does not encrypt the local recording.
`;
}

function linearReadme(config, environmentVariables = []) {
  const run = config.testRunner === 'unittest'
    ? 'python -m unittest discover -s tests -p "test_recorded_flow.py" -v'
    : config.testRunner === 'pytest'
      ? 'pytest tests/test_recorded_flow.py -v'
      : 'python tests/test_recorded_flow.py';
  return `# ${config.projectName}

Auto-generated by the Selenium Recorder Chrome extension (Linear framework).

${config.testRunner === 'unittest'
    ? 'A direct Selenium flow structured as a unittest case.'
    : config.testRunner === 'pytest'
      ? 'A direct Selenium flow wrapped in a Pytest fixture and test.'
      : 'A single, direct Selenium script with no test framework or explicit waits.'}
The recorded actions replay in order.

## Setup
\`\`\`bash
pip install -r requirements.txt
\`\`\`

## Run
\`\`\`bash
${run}
\`\`\`

${environmentSetupNote(environmentVariables)}
## Notes
- Uses \`driver.find_element(...)\` directly with no explicit wait — if your
  app renders asynchronously, elements may not be present yet. Add
  \`WebDriverWait\`/\`time.sleep()\` where needed, or use the POM export.
- Selenium 4.10+ resolves the ChromeDriver binary automatically (Selenium
  Manager); \`webdriver-manager\` is included as a fallback if you switch
  browsers.
`;
}

function pomReadme(config, pages, testDataEntries = []) {
  const moduleList = Array.from(new Set(Array.from(pages.values()).map((p) => p.moduleKey)));
  const structureLines = moduleList.length
    ? moduleList
        .map((m) => `- \`${m}/\` — feature module derived from the first URL path segment (e.g. \`${m}/LoginAction/\`, \`${m}/LoginLocators/\`).`)
        .join('\n')
    : '- Feature-module folders are created per recorded URL (first path segment).';

  const runner = config.testRunner === 'unittest' ? 'unittest' : 'Pytest';
  const runCommand = config.testRunner === 'unittest' ? 'python -m unittest discover -s tests -v' : 'pytest tests/ -v';
  const workflowFile = config.testRunner === 'unittest' ? '' : '.github/workflows/tests.yml\n';
  const screenshotNote = config.screenshots === false ? '' : '- `screenshots/` — populated automatically on action failures.\n';
  const testStructureNote = config.testRunner === 'unittest'
    ? '- `tests/` — one unittest case that executes the recorded flow in sequence. Only the first selected browser is used.\n'
    : '- `tests/` — a multi-browser `driver_setup` fixture and one test function that executes the complete flow in order.\n';
  const pytestDetail = config.testRunner === 'unittest'
    ? ''
    : `- \`conftest.py\` (project root) — anchors the project directory onto \`sys.path\` and adds a styled QA dashboard to the HTML report.
- \`pytest.ini\` — configures the self-contained HTML report${config.logging === false ? '' : ' and action log'}.
`;
  const reportNote = config.testRunner === 'unittest'
    ? ''
    : `After the run, check \`report.html\` for the dashboard, environment details, test results, and failure tracebacks.${config.logging === false ? '' : ' Check \`automation.log\` for timestamped action details.'}
`;
  const workflowNote = config.testRunner === 'unittest'
    ? ''
    : '- `.github/workflows/tests.yml` — runs the suite on every push/PR to\n' +
      '  `main`, uploading configured artifacts on failure.\n';
  const sensitiveDataNote = environmentSetupNote(testDataEntries.filter((entry) => entry.envVar));
  return `# ${config.projectName}

Auto-generated by the Selenium Recorder Chrome extension (Page Object Model, ${runner}).

## Structure
\`\`\`
${workflowFile.trimEnd()}
config/
    __init__.py
    config.py
<module>/
    __init__.py
    <Page>Action/
        __init__.py
        <page>Page.py
    <Page>Locators/
        __init__.py
        <page>Locators.py
tests/
    test_${slugify(config.projectName, 'recorded_flow')}.py
assets/
${config.screenshots === false ? '' : 'screenshots/\n'}
${config.testRunner === 'unittest' ? '' : 'conftest.py\npytest.ini'}
LICENSE
healed_locators.json
requirements.txt
README.md
\`\`\`
- \`conftest.py\`/ \`pytest.ini\` — generated for Pytest projects only.
- \`config/config.py\` — \`Config\` class with the base URL, timeout
  settings, and every recorded field's test data (username/password get
  their own names; everything else is named from its field). Add any
  other test data your suite needs here too.
- Pages are grouped into a top-level module per feature, taken from the
  first URL path segment (e.g. \`/identity/login\` → module \`identity\`,
  page \`login\`), and named by the last segment:
${structureLines}
- Inside each module: \`<Page>Action/<page>Page.py\` — one class per
  recorded page, with a \`open_<page>_page()\` navigation method plus one
  method per interaction, each with logging, specific-exception
  handling, and screenshot-on-failure; \`<Page>Locators/<page>Locators.py\`
  — that page's locator constants.
- \`assets/\` — static test data/fixtures you add yourself. Add \`assets/logo.png\` (or \`.svg\`/\`.jpg\`) to show your logo in the report header.
${screenshotNote.trimEnd()}
${testStructureNote.trimEnd()}
${pytestDetail.trimEnd()}
- \`healed_locators.json\` — reserved for a future self-healing-locator
  feature (currently unused).
- \`LICENSE\` — MIT license stub; edit the copyright holder as needed.
${workflowNote}

## Setup
\`\`\`bash
pip install -r requirements.txt
\`\`\`

## Run
\`\`\`bash
${runCommand}
\`\`\`
${reportNote}
${sensitiveDataNote}

## Notes
- Page classes are grouped by URL path at recording time. If the same
  page was visited more than once, its class and locators are reused.
- The entry fixture opens the initial URL. Later navigation caused by a
  recorded interaction is not repeated as a direct URL open; the action
  itself drives the page transition.
- When enabled, page actions log via \`logging\` and/or capture failure
  screenshots. Actions catch
  \`TimeoutException\`/\`ElementClickInterceptedException\`/\`NoSuchElementException\`/\`StaleElementReferenceException\`
  specifically and re-raise failures. Clicks wait until clickable and
  fields wait until present. Following actions wait for their target
  elements rather than embedding destination URLs in action methods.
- Input values marked secret in the recorder are masked in the popup
  and read from environment variables by the generated project instead
  of being embedded in its source.
- Selenium 4.10+ resolves driver binaries automatically (Selenium Manager);
  \`webdriver-manager\` is included as a fallback.
`;
}

if (typeof module !== 'undefined') {
  module.exports = { buildLinearProject, buildPOMProject };
}
