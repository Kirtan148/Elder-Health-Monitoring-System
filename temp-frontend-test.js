const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const User = require('./src/models/User');
const Patient = require('./src/models/Patient');
const HealthData = require('./src/models/HealthData');
const Alert = require('./src/models/Alert');

const baseUrl = 'http://127.0.0.1:3000';
const mongoUrl = process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017/elder-health-monitoring';
const testEmailSuffix = '@codex-test.local';
const stamp = Date.now();

const creds = {
  careManager: {
    name: `Codex Care ${stamp}`,
    email: `care_front_${stamp}${testEmailSuffix}`,
    password: 'Pass1234!',
    role: 'care_manager',
  },
  parent: {
    name: `Codex Parent ${stamp}`,
    email: `parent_front_${stamp}${testEmailSuffix}`,
    password: 'Pass1234!',
    role: 'parent',
  },
  child: {
    name: `Codex Child ${stamp}`,
    email: `child_front_${stamp}${testEmailSuffix}`,
    password: 'Pass1234!',
    role: 'child',
  },
};

const results = [];

function record(name, pass, details = {}) {
  results.push({ name, pass, ...details });
}

async function api(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

function authHeader(token) {
  return token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
}

async function cleanupTestData() {
  const users = await User.find({ email: new RegExp(`${testEmailSuffix.replace('.', '\\.').replace('@', '@')}$`) }).select('_id email');
  const userIds = users.map((user) => user._id);
  const healthIds = await HealthData.find({ patientId: { $in: userIds } }).select('_id');
  const healthDataIds = healthIds.map((doc) => doc._id);

  if (healthDataIds.length > 0) {
    await Alert.deleteMany({ healthDataId: { $in: healthDataIds } });
  }

  if (userIds.length > 0) {
    await Alert.deleteMany({ patientId: { $in: userIds } });
    await HealthData.deleteMany({ patientId: { $in: userIds } });
    await Patient.deleteMany({ $or: [{ _id: { $in: userIds } }, { userId: { $in: userIds } }] });
    await User.deleteMany({ _id: { $in: userIds } });
  }
}

function decodeToken(token) {
  return jwt.decode(token);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, timeoutMs = 5000, stepMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fn();
    if (value) {
      return value;
    }
    await wait(stepMs);
  }
  return null;
}

class CDPClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.eventWaiters = [];
    this.ws.addEventListener('message', (event) => {
      const data = JSON.parse(event.data.toString());
      if (data.id) {
        const pending = this.pending.get(data.id);
        if (pending) {
          this.pending.delete(data.id);
          if (data.error) {
            pending.reject(new Error(JSON.stringify(data.error)));
          } else {
            pending.resolve(data.result);
          }
        }
        return;
      }
      this.eventWaiters = this.eventWaiters.filter((waiter) => {
        if (waiter.method === data.method) {
          waiter.resolve(data.params || {});
          return false;
        }
        return true;
      });
    });
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  waitForEvent(method, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const entry = {
        method,
        resolve: (params) => {
          clearTimeout(timer);
          resolve(params);
        },
      };
      const timer = setTimeout(() => {
        this.eventWaiters = this.eventWaiters.filter((waiter) => waiter !== entry);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      this.eventWaiters.push(entry);
    });
  }

  async navigate(url) {
    const loadPromise = this.waitForEvent('Page.loadEventFired', 10000).catch(() => null);
    await this.send('Page.navigate', { url });
    await loadPromise;
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Evaluation failed');
    }
    return result.result ? result.result.value : undefined;
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function connectBrowser() {
  const targetInfo = await waitFor(async () => {
    try {
      const response = await fetch('http://127.0.0.1:9444/json/list');
      if (!response.ok) {
        return null;
      }
      const targets = await response.json();
      return Array.isArray(targets) ? targets.find((target) => target.type === 'page') || null : null;
    } catch {
      return null;
    }
  }, 10000, 200);

  if (!targetInfo?.webSocketDebuggerUrl) {
    throw new Error('Unable to connect to Edge DevTools');
  }

  const client = new CDPClient(targetInfo.webSocketDebuggerUrl);
  await client.open();
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  return client;
}

async function setSession(client, token) {
  const decoded = decodeToken(token);
  const user = { id: decoded.id, role: decoded.role };
  await client.navigate(`${baseUrl}/login.html`);
  await client.evaluate(`
    (() => {
      localStorage.setItem('ehm_token', ${JSON.stringify(token)});
      localStorage.setItem('ehm_user', ${JSON.stringify(JSON.stringify(user))});
      return true;
    })()
  `);
}

(async () => {
  await mongoose.connect(mongoUrl);
  let client;
  try {
    await cleanupTestData();

    for (const user of Object.values(creds)) {
      await api('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(user),
      });
    }

    const tokens = {};
    for (const [key, user] of Object.entries(creds)) {
      const response = await api('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email, password: user.password }),
      });
      tokens[key] = response.body.token;
    }

    const childId = decodeToken(tokens.child).id;
    await mongoose.connection.db.collection('patients').updateOne(
      { _id: new mongoose.Types.ObjectId(childId) },
      { $set: { age: 21 } }
    );

    await api('/api/health', {
      method: 'POST',
      headers: authHeader(tokens.careManager),
      body: JSON.stringify({ heartRate: 72, oxygen: 97, bp: '120/80', patientId: childId }),
    });

    client = await connectBrowser();

    await client.navigate(`${baseUrl}/register.html`);
    const registerPage = await client.evaluate(`({ path: location.pathname, hasForm: !!document.getElementById('register-form') })`);
    record('Frontend register page loads', registerPage.path === '/register.html' && registerPage.hasForm, registerPage);

    await client.navigate(`${baseUrl}/login.html`);
    await client.evaluate(`
      (() => {
        localStorage.clear();
        document.getElementById('email').value = ${JSON.stringify(creds.careManager.email)};
        document.getElementById('password').value = ${JSON.stringify(creds.careManager.password)};
        document.getElementById('login-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        return true;
      })()
    `);
    const loginState = await waitFor(async () => {
      const state = await client.evaluate(`({ path: location.pathname, token: localStorage.getItem('ehm_token'), user: localStorage.getItem('ehm_user') })`);
      return state.path === '/dashboard.html' ? state : null;
    }, 8000, 250);
    record('Frontend login stores JWT and redirects to dashboard', !!(loginState && loginState.token && loginState.user), loginState || {});

    const dashboardState = await client.evaluate(`({ role: document.getElementById('user-role')?.textContent?.trim() || '', links: Array.from(document.querySelectorAll('#dashboard-links a')).map((a) => a.getAttribute('href')) })`);
    record('Frontend dashboard loads correctly', dashboardState.role === 'care manager' && dashboardState.links.includes('/add-health.html'), dashboardState);

    await client.navigate(`${baseUrl}/add-health.html`);
    const patientDropdown = await waitFor(async () => {
      const state = await client.evaluate(`({ options: Array.from(document.querySelectorAll('#patientId option')).map((option) => option.textContent.trim()) })`);
      return state.options.length > 1 ? state : null;
    }, 8000, 250);
    record('Frontend patient dropdown loads data', !!(patientDropdown && patientDropdown.options.some((text) => text.includes(creds.child.name))), patientDropdown || {});
    record('Frontend patient dropdown shows age', !!(patientDropdown && patientDropdown.options.some((text) => text.includes('(21)'))), patientDropdown || {});

    await client.evaluate(`
      (() => {
        const select = document.getElementById('patientId');
        const match = Array.from(select.options).find((option) => option.textContent.includes(${JSON.stringify(creds.child.name)}));
        if (!match) {
          return false;
        }
        select.value = match.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('heartRate').value = '45';
        document.getElementById('oxygen').value = '91';
        document.getElementById('bp').value = '150/95';
        document.getElementById('health-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        return true;
      })()
    `);
    const addHealthState = await waitFor(async () => {
      const state = await client.evaluate(`({ message: document.getElementById('health-message')?.textContent?.trim() || '', alerts: Array.from(document.querySelectorAll('#new-alerts .list-item')).map((item) => item.textContent.replace(/\s+/g, ' ').trim()) })`);
      return state.message ? state : null;
    }, 8000, 250);
    record('Frontend Add Health Data form works', !!(addHealthState && addHealthState.message.includes('saved successfully')), addHealthState || {});

    await client.navigate(`${baseUrl}/alerts.html`);
    const alertsState = await waitFor(async () => {
      const state = await client.evaluate(`({ items: Array.from(document.querySelectorAll('#alerts-list .list-item')).map((item) => item.textContent.replace(/\s+/g, ' ').trim()) })`);
      return state.items.length > 0 ? state : null;
    }, 8000, 250);
    record('Frontend alerts page shows alerts', !!(alertsState && alertsState.items.some((text) => text.includes('Heart rate') || text.includes('Oxygen') || text.includes('Blood pressure'))), alertsState || {});

    await setSession(client, tokens.parent);
    await client.navigate(`${baseUrl}/history.html`);
    await waitFor(async () => {
      const state = await client.evaluate(`({ count: document.querySelectorAll('#patientId option').length })`);
      return state.count > 1 ? state : null;
    }, 8000, 250);
    await client.evaluate(`
      (() => {
        const select = document.getElementById('patientId');
        const match = Array.from(select.options).find((option) => option.textContent.includes(${JSON.stringify(creds.child.name)}));
        if (!match) {
          return false;
        }
        select.value = match.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('history-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        return true;
      })()
    `);
    const historyState = await waitFor(async () => {
      const state = await client.evaluate(`({ message: document.getElementById('history-message')?.textContent?.trim() || '', items: Array.from(document.querySelectorAll('#history-list .list-item')).map((item) => item.textContent.replace(/\s+/g, ' ').trim()) })`);
      return state.message ? state : null;
    }, 8000, 250);
    record('Frontend history page shows records', !!(historyState && historyState.message.includes('Loaded history') && historyState.items.length > 0), historyState || {});

    await client.navigate(`${baseUrl}/emergency.html`);
    await client.evaluate(`document.getElementById('emergency-button').click(); true;`);
    const emergencyState = await waitFor(async () => {
      const state = await client.evaluate(`({ path: location.pathname, message: document.getElementById('emergency-message')?.textContent?.trim() || '', detailsVisible: !document.getElementById('emergency-details')?.classList.contains('hidden') })`);
      return state.message ? state : null;
    }, 5000, 200);
    record('Frontend emergency button works', !!(emergencyState && emergencyState.path === '/emergency.html' && emergencyState.detailsVisible), emergencyState || {});

    await setSession(client, tokens.child);
    await client.navigate(`${baseUrl}/add-health.html`);
    const childRedirect = await waitFor(async () => {
      const state = await client.evaluate(`({ path: location.pathname })`);
      return state.path === '/dashboard.html' ? state : null;
    }, 8000, 250);
    record('Frontend child has read-only access', !!childRedirect, childRedirect || {});

    await client.navigate(`${baseUrl}/history.html`);
    const childHistoryState = await waitFor(async () => {
      const state = await client.evaluate(`({ value: document.getElementById('patientId')?.value || '', disabled: !!document.getElementById('patientId')?.disabled })`);
      return state.disabled ? state : null;
    }, 8000, 250);
    record('Frontend child history selection is locked', !!(childHistoryState && childHistoryState.disabled), childHistoryState || {});

    await client.evaluate(`localStorage.clear(); true;`);
    await client.navigate(`${baseUrl}/add-health.html`);
    const unauthState = await waitFor(async () => {
      const state = await client.evaluate(`({ path: location.pathname })`);
      return state.path === '/login.html' ? state : null;
    }, 5000, 200);
    record('Frontend redirects unauthenticated user from protected page', !!unauthState, unauthState || {});

    console.log(JSON.stringify({ results }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ fatal: error.message, stack: error.stack, results }, null, 2));
    process.exitCode = 1;
  } finally {
    if (client) {
      client.close();
    }
    await cleanupTestData().catch(() => {});
    await mongoose.disconnect().catch(() => {});
  }
})();
