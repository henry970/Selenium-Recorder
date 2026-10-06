const ALL_BROWSERS = ['chrome', 'edge', 'firefox'];
const DEFAULT_BROWSERS = ['chrome', 'edge', 'firefox'];

const checkbox = (name) => document.getElementById(`browser-${name}`);

async function loadSettings() {
  const data = await chrome.storage.local.get(['settings']);
  const settings = data.settings || {};
  const browsers = settings.browsers || DEFAULT_BROWSERS;
  ALL_BROWSERS.forEach((name) => {
    checkbox(name).checked = browsers.includes(name);
  });
  document.getElementById('include-screenshots').checked = settings.screenshots !== false;
  document.getElementById('include-logging').checked = settings.logging !== false;
}

async function saveSettings() {
  const browsers = ALL_BROWSERS.filter((name) => checkbox(name).checked);
  // Always keep at least one browser selected — an empty list would
  // produce a driver_setup fixture with no params at all.
  const finalBrowsers = browsers.length ? browsers : ['chrome'];
  if (!browsers.length) checkbox('chrome').checked = true;

  const existing = (await chrome.storage.local.get(['settings'])).settings || {};
  await chrome.storage.local.set({
    settings: {
      ...existing,
      browsers: finalBrowsers,
      screenshots: document.getElementById('include-screenshots').checked,
      logging: document.getElementById('include-logging').checked
    }
  });

  const notice = document.getElementById('savedNotice');
  notice.classList.remove('hidden');
  notice.classList.add('visible');
  setTimeout(() => {
    notice.classList.remove('visible');
    notice.classList.add('hidden');
  }, 1800);
}

document.addEventListener('DOMContentLoaded', loadSettings);
document.getElementById('btnSave').addEventListener('click', saveSettings);
