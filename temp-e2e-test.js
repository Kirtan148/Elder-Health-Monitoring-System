const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');

const User = require('./src/models/User');
const Patient = require('./src/models/Patient');
const HealthData = require('./src/models/HealthData');
const Alert = require('./src/models/Alert');

const baseUrl = 'http://127.0.0.1:3000';
const mongoUrl = process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017/elder-health-monitoring';
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const testEmailSuffix = '@codex-test.local';
const stamp = Date.now();

const creds = {
  careManager: {
    name: `Codex Care ${stamp}`,
    email: `care_${stamp}${testEmailSuffix}`,
    password: 'Pass1234!',
    role: 'care_manager',
  },
  parent: {
    name: `Codex Parent ${stamp}`,
    email: `parent_${stamp}${testEmailSuffix}`,
    password: 'Pass1234!',
    role: 'parent',
  },
  child: {
    name: `Codex Child ${stamp}`,
    email: `child_${stamp}${testEmailSuffix}`,
    password: 'Pass1234!',
    role: 'child',
  },
};

const results = [];
const notes = [];
const browserArtifacts = [];

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
  return { status: response.status, body, headers: Object.fromEntries(response.headers.entries()) };
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

async function getRawPatient(id) {
  return mongoose.connection.db.collection('patients').findOne({ _id: new mongoose.Types.ObjectId(id) });
}

async function setRawPatientAge(id, age) {
  await mongoose.connection.db.collection('patients').updateOne(
    { _id: new mongoose.Types.ObjectId(id) },
    { $set: { age } }
  );
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

async function launchBrowser() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ehm-edge-'));
  const browser = spawn(edgePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--remote-debugging-port=9444',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: 'ignore' });

  browserArtifacts.push({ browser, userDataDir });

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

  if (!targetInfo || !targetInfo.webSocketDebuggerUrl) {
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

async function runBrowserChecks(tokens) {
  const client = await launchBrowser();
  try {
    await client.navigate(`${baseUrl}/register.html`);
    const registerPage = await client.evaluate(`
      (() => ({
        path: location.pathname,
        hasForm: !!document.getElementById('register-form'),
        roleOptions: Array.from(document.querySelectorAll('#role option')).map((option) => option.value),
      }))()
    `);
    record('Frontend register page loads', registerPage.path === '/register.html' && registerPage.hasForm && registerPage.roleOptions.length === 3, registerPage);

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
      const state = await client.evaluate(`
        (() => ({
          path: location.pathname,
          token: localStorage.getItem('ehm_token'),
          user: localStorage.getItem('ehm_user'),
          message: document.getElementById('login-message')?.textContent?.trim() || '',
        }))()
      `);
      return state.path === '/dashboard.html' ? state : null;
    }, 8000, 250);
    record('Frontend login stores JWT and redirects to dashboard', !!(loginState && loginState.token && loginState.user), loginState || {});

    const dashboardState = await client.evaluate(`
      (() => ({
        role: document.getElementById('user-role')?.textContent?.trim() || '',
        userId: document.getElementById('user-id')?.textContent?.trim() || '',
        links: Array.from(document.querySelectorAll('#dashboard-links a')).map((a) => a.getAttribute('href')),
      }))()
    `);
    record('Frontend dashboard loads after login', dashboardState.role === 'care manager' && !!dashboardState.userId, dashboardState);

    await client.navigate(`${baseUrl}/add-health.html`);
    const patientDropdown = await waitFor(async () => {
      const state = await client.evaluate(`
        (() => ({
          path: location.pathname,
          options: Array.from(document.querySelectorAll('#patientId option')).map((option) => option.textContent.trim()),
          message: document.getElementById('health-message')?.textContent?.trim() || '',
        }))()
      `);
      return state.options.length > 1 ? state : null;
    }, 8000, 250);
    record('Frontend patient dropdown loads data', !!(patientDropdown && patientDropdown.options.some((text) => text.includes(creds.child.name))), patientDropdown || {});
    record('Frontend patient dropdown shows age', !!(patientDropdown && patientDropdown.options.some((text) => text.includes('(21)'))), patientDropdown || {});

    const addHealthSubmit = await client.evaluate(`
      (() => {
        const select = document.getElementById('patientId');
        const match = Array.from(select.options).find((option) => option.textContent.includes(${JSON.stringify(creds.child.name)}));
        if (!match) {
          return { submitted: false, reason: 'patient missing' };
        }
        select.value = match.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('heartRate').value = '45';
        document.getElementById('oxygen').value = '91';
        document.getElementById('bp').value = '150/95';
        document.getElementById('health-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        return { submitted: true };
      })()
    `);

    const addHealthState = await waitFor(async () => {
      const state = await client.evaluate(`
        (() => ({
          message: document.getElementById('health-message')?.textContent?.trim() || '',
          alerts: Array.from(document.querySelectorAll('#new-alerts .list-item')).map((item) => item.textContent.replace(/\s+/g, ' ').trim()),
        }))()
      `);
      return state.message ? state : null;
    }, 8000, 250);
    record('Frontend Add Health Data form works', !!(addHealthSubmit.submitted && addHealthState && addHealthState.message.includes('saved successfully')), { ...addHealthSubmit, ...(addHealthState || {}) });

    await client.navigate(`${baseUrl}/alerts.html`);
    const alertsPage = await waitFor(async () => {
      const state = await client.evaluate(`
        (() => ({
          path: location.pathname,
          items: Array.from(document.querySelectorAll('#alerts-list .list-item')).map((item) => item.textContent.replace(/\s+/g, ' ').trim()),
          message: document.getElementById('alerts-message')?.textContent?.trim() || '',
        }))()
      `);
      return state.items.length > 0 ? state : null;
    }, 8000, 250);
    record('Frontend alerts page shows alerts', !!(alertsPage && alertsPage.items.some((text) => text.includes('Heart rate'))), alertsPage || {});

    await setSession(client, tokens.parent);
    await client.navigate(`${baseUrl}/history.html`);
    const historyLoad = await waitFor(async () => {
      const state = await client.evaluate(`
        (() => ({
          options: Array.from(document.querySelectorAll('#patientId option')).map((option) => ({ value: option.value, text: option.textContent.trim() })),
          message: document.getElementById('history-message')?.textContent?.trim() || '',
        }))()
      `);
      return state.options.length > 1 ? state : null;
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
      const state = await client.evaluate(`
        (() => ({
          message: document.getElementById('history-message')?.textContent?.trim() || '',
          items: Array.from(document.querySelectorAll('#history-list .list-item')).map((item) => item.textContent.replace(/\s+/g, ' ').trim()),
        }))()
      `);
      return state.message ? state : null;
    }, 8000, 250);
    record('Frontend history page shows records', !!(historyState && historyState.message.includes('Loaded history') && historyState.items.length > 0), { ...(historyLoad || {}), ...(historyState || {}) });

    await client.navigate(`${baseUrl}/emergency.html`);
    await client.evaluate(`document.getElementById('emergency-button').click(); true;`);
    const emergencyState = await waitFor(async () => {
      const state = await client.evaluate(`
        (() => ({
          path: location.pathname,
          message: document.getElementById('emergency-message')?.textContent?.trim() || '',
          detailsVisible: !document.getElementById('emergency-details')?.classList.contains('hidden'),
        }))()
      `);
      return state.message ? state : null;
    }, 5000, 200);
    record('Frontend emergency button works for parent', !!(emergencyState && emergencyState.path === '/emergency.html' && emergencyState.detailsVisible), emergencyState || {});

    await setSession(client, tokens.child);
    await client.navigate(`${baseUrl}/add-health.html`);
    const childRedirect = await waitFor(async () => {
      const state = await client.evaluate(`
        (() => ({
          path: location.pathname,
          role: document.getElementById('user-role')?.textContent?.trim() || '',
          links: Array.from(document.querySelectorAll('#dashboard-links a')).map((a) => a.getAttribute('href')),
        }))()
      `);
      return state.path === '/dashboard.html' ? state : null;
    }, 8000, 250);
    record('Child is blocked from Add Health page in frontend', !!childRedirect, childRedirect || {});

    await client.navigate(`${baseUrl}/history.html`);
    const childHistoryState = await waitFor(async () => {
      const state = await client.evaluate(`
        (() => ({
          path: location.pathname,
          value: document.getElementById('patientId')?.value || '',
          disabled: !!document.getElementById('patientId')?.disabled,
        }))()
      `);
      return state.disabled ? state : null;
    }, 8000, 250);
    record('Child has read-only patient history selection', !!(childHistoryState && childHistoryState.disabled), childHistoryState || {});

    await client.evaluate(`
      (() => {
        localStorage.clear();
        return true;
      })()
    `);
    await client.navigate(`${baseUrl}/add-health.html`);
    const noAuthState = await waitFor(async () => {
      const state = await client.evaluate(`({ path: location.pathname })`);
      return state.path === '/login.html' ? state : null;
    }, 5000, 200);
    record('Frontend redirects unauthenticated user from protected page', !!noAuthState, noAuthState || {});
  } finally {
    client.close();
  }
}

(async () => {
  await mongoose.connect(mongoUrl);
  try {
    await cleanupTestData();

    const registerCases = [creds.careManager, creds.parent, creds.child];
    for (const user of registerCases) {
      const response = await api('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(user),
      });
      record(`Register ${user.role}`, response.status === 201, { status: response.status, body: response.body });
    }

    const tokens = {};
    const decodedTokens = {};
    for (const [key, user] of Object.entries(creds)) {
      const response = await api('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email, password: user.password }),
      });
      const token = response.body && response.body.token;
      const decoded = token ? decodeToken(token) : null;
      tokens[key] = token;
      decodedTokens[key] = decoded;
      record(`Login ${user.role}`, response.status === 200 && !!token && decoded && decoded.role === user.role, {
        status: response.status,
        hasToken: !!token,
        decoded,
      });
    }

    const childId = decodedTokens.child && decodedTokens.child.id;
    const childUser = await User.findById(childId).select('_id name email role');
    const childPatient = await Patient.findById(childId).lean();
    record('Child registration creates matching patient', !!(childUser && childPatient && String(childUser._id) === String(childPatient._id)), {
      childUser,
      childPatient,
    });

    await setRawPatientAge(childId, 21);
    const rawPatient = await getRawPatient(childId);
    record('Raw patient document contains age in MongoDB', rawPatient && rawPatient.age === 21, { rawPatient });

    const unauthPatients = await api('/api/patients');
    record('GET /api/patients without token is rejected', unauthPatients.status === 401, { status: unauthPatients.status, body: unauthPatients.body });

    const unauthHealth = await api('/api/health', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ heartRate: 72, oxygen: 97, bp: '120/80', patientId: childId }),
    });
    record('POST /api/health without token is rejected', unauthHealth.status === 401, { status: unauthHealth.status, body: unauthHealth.body });

    const unauthAlerts = await api('/api/alerts');
    record('GET /api/alerts without token is rejected', unauthAlerts.status === 401, { status: unauthAlerts.status, body: unauthAlerts.body });

    const parentDenied = await api('/api/health', {
      method: 'POST',
      headers: authHeader(tokens.parent),
      body: JSON.stringify({ heartRate: 72, oxygen: 97, bp: '120/80', patientId: childId }),
    });
    record('Parent cannot add health data', parentDenied.status === 403, { status: parentDenied.status, body: parentDenied.body });

    const childDenied = await api('/api/health', {
      method: 'POST',
      headers: authHeader(tokens.child),
      body: JSON.stringify({ heartRate: 72, oxygen: 97, bp: '120/80', patientId: childId }),
    });
    record('Child cannot add health data', childDenied.status === 403, { status: childDenied.status, body: childDenied.body });

    const validHealth = await api('/api/health', {
      method: 'POST',
      headers: authHeader(tokens.careManager),
      body: JSON.stringify({ heartRate: 72, oxygen: 97, bp: '120/80', patientId: childId }),
    });
    record('Care manager can add valid health data', validHealth.status === 201 && validHealth.body && validHealth.body.healthData, {
      status: validHealth.status,
      body: validHealth.body,
    });

    const heartRateAlert = await api('/api/health', {
      method: 'POST',
      headers: authHeader(tokens.careManager),
      body: JSON.stringify({ heartRate: 45, oxygen: 97, bp: '120/80', patientId: childId }),
    });
    const oxygenAlert = await api('/api/health', {
      method: 'POST',
      headers: authHeader(tokens.careManager),
      body: JSON.stringify({ heartRate: 72, oxygen: 91, bp: '120/80', patientId: childId }),
    });
    const bpAlert = await api('/api/health', {
      method: 'POST',
      headers: authHeader(tokens.careManager),
      body: JSON.stringify({ heartRate: 72, oxygen: 97, bp: '150/95', patientId: childId }),
    });

    const heartAlertStored = heartRateAlert.body?.healthData?._id ? await Alert.find({ healthDataId: heartRateAlert.body.healthData._id }).lean() : [];
    const oxygenAlertStored = oxygenAlert.body?.healthData?._id ? await Alert.find({ healthDataId: oxygenAlert.body.healthData._id }).lean() : [];
    const bpAlertStored = bpAlert.body?.healthData?._id ? await Alert.find({ healthDataId: bpAlert.body.healthData._id }).lean() : [];

    record('Heart rate <50 generates alert', heartRateAlert.status === 201 && heartRateAlert.body?.alerts?.some((alert) => alert.type === 'heartRate' && alert.severity === 'alert') && heartAlertStored.some((alert) => alert.type === 'heartRate'), {
      status: heartRateAlert.status,
      body: heartRateAlert.body,
      stored: heartAlertStored,
    });
    record('Oxygen <92 generates critical alert', oxygenAlert.status === 201 && oxygenAlert.body?.alerts?.some((alert) => alert.type === 'oxygen' && alert.severity === 'critical') && oxygenAlertStored.some((alert) => alert.type === 'oxygen'), {
      status: oxygenAlert.status,
      body: oxygenAlert.body,
      stored: oxygenAlertStored,
    });
    record('BP >140/90 generates warning alert', bpAlert.status === 201 && bpAlert.body?.alerts?.some((alert) => alert.type === 'bp' && alert.severity === 'warning') && bpAlertStored.some((alert) => alert.type === 'bp'), {
      status: bpAlert.status,
      body: bpAlert.body,
      stored: bpAlertStored,
    });

    const patientsResponse = await api('/api/patients', {
      headers: { Authorization: `Bearer ${tokens.careManager}` },
    });
    const childInPatients = Array.isArray(patientsResponse.body?.patients)
      ? patientsResponse.body.patients.find((patient) => String(patient._id) === String(childId))
      : null;
    record('GET /api/patients returns patient list', patientsResponse.status === 200 && !!childInPatients, {
      status: patientsResponse.status,
      childPatient: childInPatients,
    });
    record('GET /api/patients returns patient age', !!(childInPatients && childInPatients.age === 21), {
      status: patientsResponse.status,
      childPatient: childInPatients,
    });

    const patientByIdResponse = await api(`/api/patient/${childId}`, {
      headers: { Authorization: `Bearer ${tokens.parent}` },
    });
    record('GET /api/patient/:id returns patient and health records', patientByIdResponse.status === 200 && patientByIdResponse.body?.patient && Array.isArray(patientByIdResponse.body?.healthRecords) && patientByIdResponse.body.healthRecords.length >= 4, {
      status: patientByIdResponse.status,
      body: patientByIdResponse.body,
    });

    const alertsResponse = await api('/api/alerts', {
      headers: { Authorization: `Bearer ${tokens.parent}` },
    });
    record('GET /api/alerts returns alerts', alertsResponse.status === 200 && Array.isArray(alertsResponse.body?.alerts) && alertsResponse.body.alerts.length >= 3, {
      status: alertsResponse.status,
      bodyCount: Array.isArray(alertsResponse.body?.alerts) ? alertsResponse.body.alerts.length : null,
    });

    const healthDocs = await HealthData.find({ patientId: childId }).lean();
    const alertDocs = await Alert.find({ patientId: childId }).lean();
    record('Health data is stored with patientId ObjectId', healthDocs.length >= 4 && healthDocs.every((doc) => String(doc.patientId) === String(childId)), {
      count: healthDocs.length,
      sample: healthDocs[0] || null,
    });
    record('Alerts are stored with patientId and healthDataId', alertDocs.length >= 3 && alertDocs.every((doc) => String(doc.patientId) === String(childId) && !!doc.healthDataId), {
      count: alertDocs.length,
      sample: alertDocs[0] || null,
    });

    const invalidBp = await api('/api/health', {
      method: 'POST',
      headers: authHeader(tokens.careManager),
      body: JSON.stringify({ heartRate: 72, oxygen: 97, bp: '120-80', patientId: childId }),
    });
    record('Invalid BP format returns 400', invalidBp.status === 400, { status: invalidBp.status, body: invalidBp.body });

    const invalidPatientId = await api('/api/health', {
      method: 'POST',
      headers: authHeader(tokens.careManager),
      body: JSON.stringify({ heartRate: 72, oxygen: 97, bp: '120/80', patientId: 'bad-id' }),
    });
    record('Invalid patientId returns 400', invalidPatientId.status === 400, { status: invalidPatientId.status, body: invalidPatientId.body });

    const emptyForm = await api('/api/health', {
      method: 'POST',
      headers: authHeader(tokens.careManager),
      body: JSON.stringify({}),
    });
    record('Empty health submission returns 400', emptyForm.status === 400, { status: emptyForm.status, body: emptyForm.body });

    try {
      await runBrowserChecks(tokens);
    } catch (error) {
      record('Browser-based frontend checks executed', false, { error: error.message });
      notes.push(`Frontend automation could not finish: ${error.message}`);
    }

    console.log(JSON.stringify({ results, notes }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ fatal: error.message, stack: error.stack }, null, 2));
    process.exitCode = 1;
  } finally {
    await cleanupTestData().catch(() => {});
    await mongoose.disconnect().catch(() => {});
    for (const artifact of browserArtifacts) {
      try {
        artifact.browser.kill();
      } catch {}
      try {
        fs.rmSync(artifact.userDataDir, { recursive: true, force: true });
      } catch {}
    }
  }
})();

