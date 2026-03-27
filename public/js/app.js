const TOKEN_KEY = "ehm_token";
const USER_KEY = "ehm_user";

const escapeHtml = (value) => {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
};

const formatRole = (role) => {
  return String(role || "").replace(/_/g, " ");
};

const parseJwt = (token) => {
  try {
    const base64Url = token.split(".")[1];
    const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    return JSON.parse(window.atob(padded));
  } catch (error) {
    return null;
  }
};

const saveSession = (token) => {
  const user = parseJwt(token);

  if (!user) {
    throw new Error("Invalid token received");
  }

  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
};

const getToken = () => localStorage.getItem(TOKEN_KEY);

const getUser = () => {
  const storedUser = localStorage.getItem(USER_KEY);

  if (!storedUser) {
    return null;
  }

  try {
    return JSON.parse(storedUser);
  } catch (error) {
    clearSession();
    return null;
  }
};

const clearSession = () => {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
};

const getSession = () => ({
  token: getToken(),
  user: getUser(),
});

const showMessage = (elementId, text, type = "info") => {
  const element = document.getElementById(elementId);

  if (!element) {
    return;
  }

  if (!text) {
    element.textContent = "";
    element.className = "message hidden";
    return;
  }

  element.textContent = text;
  element.className = `message ${type}`;
};

const requireAuth = (allowedRoles = []) => {
  const session = getSession();

  if (!session.token || !session.user) {
    window.location.href = "/login.html";
    return null;
  }

  if (allowedRoles.length > 0 && !allowedRoles.includes(session.user.role)) {
    window.location.href = "/dashboard.html";
    return null;
  }

  return session;
};

const apiRequest = async (url, options = {}) => {
  const session = getSession();
  const headers = { ...(options.headers || {}) };

  if (options.body && !(options.body instanceof FormData) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  if (session.token) {
    headers.Authorization = `Bearer ${session.token}`;
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    if (response.status === 401 && url !== "/auth/login") {
      clearSession();
      window.location.href = "/login.html";
    }

    throw new Error(data.message || "Request failed");
  }

  return data;
};

const renderNav = () => {
  const container = document.getElementById("app-nav");

  if (!container) {
    return;
  }

  const session = getSession();

  if (!session.token || !session.user) {
    container.innerHTML = `
      <div class="navbar">
        <div class="navbar-title">Elder Health Monitoring</div>
        <div class="navbar-links">
          <a href="/login.html">Login</a>
          <a href="/register.html">Register</a>
        </div>
      </div>
    `;
    return;
  }

  const links = [
    '<a href="/dashboard.html">Dashboard</a>',
    '<a href="/alerts.html">Alerts</a>',
    '<a href="/history.html">Patient History</a>',
  ];

  if (session.user.role === "care_manager") {
    links.push('<a href="/add-health.html">Add Health Data</a>');
  }

  if (session.user.role === "parent") {
    links.push('<a href="/emergency.html">Emergency</a>');
  }

  links.push('<button id="logout-button" class="secondary" type="button">Logout</button>');

  container.innerHTML = `
    <div class="navbar">
      <div>
        <div class="navbar-title">Elder Health Monitoring</div>
        <div class="small-text">Logged in as ${escapeHtml(formatRole(session.user.role))}</div>
      </div>
      <div class="navbar-links">${links.join("")}</div>
    </div>
  `;

  const logoutButton = document.getElementById("logout-button");

  if (logoutButton) {
    logoutButton.addEventListener("click", () => {
      clearSession();
      window.location.href = "/login.html";
    });
  }
};

const renderAlerts = (alerts, elementId, emptyMessage) => {
  const element = document.getElementById(elementId);

  if (!element) {
    return;
  }

  if (!alerts || alerts.length === 0) {
    element.innerHTML = `<div class="list-item">${escapeHtml(emptyMessage)}</div>`;
    return;
  }

  element.innerHTML = alerts
    .map((alert) => `
      <div class="list-item">
        <span class="badge ${escapeHtml(alert.severity)}">${escapeHtml(alert.severity)}</span>
        <p><strong>Type:</strong> ${escapeHtml(alert.type)}</p>
        <p><strong>Message:</strong> ${escapeHtml(alert.message)}</p>
        <p class="inline-meta">Patient ID: ${escapeHtml(alert.patientId)}</p>
      </div>
    `)
    .join("");
};

const renderHealthRecords = (records, elementId) => {
  const element = document.getElementById(elementId);

  if (!element) {
    return;
  }

  if (!records || records.length === 0) {
    element.innerHTML = '<div class="list-item">No health records found.</div>';
    return;
  }

  element.innerHTML = records
    .map((record) => `
      <div class="list-item">
        <p><strong>Heart Rate:</strong> ${escapeHtml(record.heartRate)}</p>
        <p><strong>Oxygen:</strong> ${escapeHtml(record.oxygen)}</p>
        <p><strong>Blood Pressure:</strong> ${escapeHtml(record.bp)}</p>
        <p class="inline-meta">Record ID: ${escapeHtml(record._id)}</p>
      </div>
    `)
    .join("");
};

const formatPatientOptionLabel = (patient) => {
  const shortId = String(patient._id || "").slice(-6);

  return shortId
    ? `${patient.name} (${shortId})`
    : patient.name;
};

const updateSelectedPatientId = (select) => {
  const selectedIdElementId = select.dataset.selectedIdElementId;
  const selectedIdElement = selectedIdElementId
    ? document.getElementById(selectedIdElementId)
    : null;

  if (selectedIdElement) {
    selectedIdElement.textContent = select.value || "Not selected";
  }
};

const setPatientSelectOptions = (selectId, patients, selectedIdElementId, selectedValue = "") => {
  const select = document.getElementById(selectId);

  if (!select) {
    return;
  }

  if (patients.length === 0) {
    select.innerHTML = '<option value="">No patients found</option>';
    select.value = "";
  } else {
    select.innerHTML = `
      <option value="">Select a patient</option>
      ${patients
        .map(
          (patient) =>
            `<option value="${escapeHtml(patient._id)}">${escapeHtml(formatPatientOptionLabel(patient))}</option>`
        )
        .join("")}
    `;

    const hasSelectedPatient = patients.some((patient) => patient._id === selectedValue);
    select.value = hasSelectedPatient ? selectedValue : "";
  }

  select.dataset.selectedIdElementId = selectedIdElementId || "";

  if (select.dataset.patientSelectBound !== "true") {
    select.addEventListener("change", () => {
      updateSelectedPatientId(select);
    });
    select.dataset.patientSelectBound = "true";
  }

  updateSelectedPatientId(select);
};

const fetchPatients = async () => {
  const data = await apiRequest("/api/patients");
  return data.patients || [];
};

const populatePatientSelect = async (selectId, messageId, selectedIdElementId, selectedValue = "") => {
  const select = document.getElementById(selectId);

  if (!select) {
    return [];
  }

  try {
    const patients = await fetchPatients();
    setPatientSelectOptions(selectId, patients, selectedIdElementId, selectedValue);
    return patients;
  } catch (error) {
    showMessage(messageId, error.message, "error");
    setPatientSelectOptions(selectId, [], selectedIdElementId);
    return [];
  }
};

const initLoginPage = () => {
  if (getToken()) {
    window.location.href = "/dashboard.html";
    return;
  }

  const form = document.getElementById("login-form");

  if (!form) {
    return;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    showMessage("login-message", "", "info");

    const formData = new FormData(form);

    try {
      const data = await apiRequest("/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email: formData.get("email"),
          password: formData.get("password"),
        }),
      });

      saveSession(data.token);
      showMessage("login-message", "Login successful. Redirecting...", "success");
      window.setTimeout(() => {
        window.location.href = "/dashboard.html";
      }, 500);
    } catch (error) {
      showMessage("login-message", error.message, "error");
    }
  });
};

const initRegisterPage = () => {
  const form = document.getElementById("register-form");
  const roleSelect = document.getElementById("role");
  const patientField = document.getElementById("register-patient-field");
  const patientInput = document.getElementById("register-patientId");

  if (!form || !roleSelect || !patientField || !patientInput) {
    return;
  }

  const syncRegisterPatientField = () => {
    const needsPatientId = roleSelect.value === "parent" || roleSelect.value === "child";

    patientField.classList.toggle("hidden", !needsPatientId);
    patientInput.required = needsPatientId;

    if (!needsPatientId) {
      patientInput.value = "";
    }
  };

  roleSelect.addEventListener("change", syncRegisterPatientField);
  syncRegisterPatientField();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    showMessage("register-message", "", "info");

    const formData = new FormData(form);
    const role = String(formData.get("role") || "");
    const payload = {
      name: formData.get("name"),
      email: formData.get("email"),
      password: formData.get("password"),
      role,
    };

    if (role === "parent" || role === "child") {
      const patientId = String(formData.get("patientId") || "").trim();

      if (!patientId) {
        showMessage("register-message", "Patient ID is required for parent and child accounts.", "error");
        return;
      }

      payload.patientId = patientId;
    }

    try {
      await apiRequest("/auth/register", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      form.reset();
      syncRegisterPatientField();
      showMessage("register-message", "Registration successful. Redirecting to login...", "success");
      window.setTimeout(() => {
        window.location.href = "/login.html";
      }, 700);
    } catch (error) {
      showMessage("register-message", error.message, "error");
    }
  });
};

const initDashboardPage = () => {
  const session = requireAuth();

  if (!session) {
    return;
  }

  const roleElement = document.getElementById("user-role");
  const idElement = document.getElementById("user-id");
  const linksElement = document.getElementById("dashboard-links");
  const roleNoteElement = document.getElementById("role-note");

  if (roleElement) {
    roleElement.textContent = formatRole(session.user.role);
  }

  if (idElement) {
    idElement.textContent = session.user.id;
  }

  const links = [
    {
      href: "/alerts.html",
      title: "View Alerts",
      text: "See all saved alerts.",
    },
    {
      href: "/history.html",
      title: "Patient History",
      text: "Load health records by choosing a patient.",
    },
  ];

  if (session.user.role === "care_manager") {
    links.unshift({
      href: "/add-health.html",
      title: "Add Health Data",
      text: "Create a new health record for a selected patient.",
    });
  }

  if (session.user.role === "parent") {
    links.push({
      href: "/emergency.html",
      title: "Emergency Button",
      text: "Open the parent emergency action page.",
    });
  }

  if (linksElement) {
    linksElement.innerHTML = links
      .map((link) => `
        <a class="link-card" href="${escapeHtml(link.href)}">
          <strong>${escapeHtml(link.title)}</strong>
          <span class="small-text">${escapeHtml(link.text)}</span>
        </a>
      `)
      .join("");
  }

  if (roleNoteElement) {
    if (session.user.role === "care_manager") {
      roleNoteElement.textContent = "You can choose a patient from the database and save health data.";
    } else if (session.user.role === "parent") {
      roleNoteElement.textContent = "You can view patient history and use the emergency button page.";
    } else {
      roleNoteElement.textContent = "You can view alerts and load patient history from the dashboard.";
    }
  }
};

const initAddHealthPage = async () => {
  const session = requireAuth(["care_manager"]);

  if (!session) {
    return;
  }

  const healthForm = document.getElementById("health-form");
  const patientSelect = document.getElementById("patientId");
  const addPatientForm = document.getElementById("add-patient-form");
  const editPatientForm = document.getElementById("edit-patient-form");
  const editPatientSelect = document.getElementById("edit-patient-id");
  const editPatientNameInput = document.getElementById("edit-patient-name");

  if (
    !healthForm ||
    !patientSelect ||
    !addPatientForm ||
    !editPatientForm ||
    !editPatientSelect ||
    !editPatientNameInput
  ) {
    return;
  }

  let patients = [];

  const syncEditPatientName = () => {
    const selectedPatient = patients.find((patient) => patient._id === editPatientSelect.value);
    editPatientNameInput.value = selectedPatient ? selectedPatient.name : "";
  };

  const refreshPatientLists = async (selectedValues = {}) => {
    const healthPatientId =
      selectedValues.healthPatientId !== undefined ? selectedValues.healthPatientId : patientSelect.value;
    const editPatientId =
      selectedValues.editPatientId !== undefined ? selectedValues.editPatientId : editPatientSelect.value;

    try {
      patients = await fetchPatients();
      setPatientSelectOptions("patientId", patients, "selected-patient-id", healthPatientId);
      setPatientSelectOptions("edit-patient-id", patients, "selected-edit-patient-id", editPatientId);
      syncEditPatientName();
      return patients;
    } catch (error) {
      showMessage("health-message", error.message, "error");
      showMessage("patient-management-message", error.message, "error");
      setPatientSelectOptions("patientId", [], "selected-patient-id");
      setPatientSelectOptions("edit-patient-id", [], "selected-edit-patient-id");
      syncEditPatientName();
      return [];
    }
  };

  editPatientSelect.addEventListener("change", syncEditPatientName);

  await refreshPatientLists();

  addPatientForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    showMessage("patient-management-message", "", "info");

    const formData = new FormData(addPatientForm);

    try {
      const data = await apiRequest("/api/patients", {
        method: "POST",
        body: JSON.stringify({
          name: formData.get("name"),
        }),
      });

      addPatientForm.reset();
      await refreshPatientLists({
        healthPatientId: data.patient._id,
        editPatientId: data.patient._id,
      });
      showMessage(
        "patient-management-message",
        `Patient ${data.patient.name} added successfully.`,
        "success"
      );
    } catch (error) {
      showMessage("patient-management-message", error.message, "error");
    }
  });

  editPatientForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    showMessage("patient-management-message", "", "info");

    const formData = new FormData(editPatientForm);
    const selectedPatientId = formData.get("patientId");

    if (!selectedPatientId) {
      showMessage("patient-management-message", "Please select a patient to edit.", "error");
      return;
    }

    try {
      const data = await apiRequest(`/api/patients/${selectedPatientId}`, {
        method: "PUT",
        body: JSON.stringify({
          name: formData.get("name"),
        }),
      });

      await refreshPatientLists({ editPatientId: data.patient._id });
      showMessage(
        "patient-management-message",
        `Patient ${data.patient.name} updated successfully.`,
        "success"
      );
    } catch (error) {
      showMessage("patient-management-message", error.message, "error");
    }
  });

  healthForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    showMessage("health-message", "", "info");
    renderAlerts([], "new-alerts", "No alerts created yet.");

    const formData = new FormData(healthForm);
    const selectedPatientId = formData.get("patientId");

    if (!selectedPatientId) {
      showMessage("health-message", "Please select a patient.", "error");
      return;
    }

    try {
      const data = await apiRequest("/api/health", {
        method: "POST",
        body: JSON.stringify({
          heartRate: Number(formData.get("heartRate")),
          oxygen: Number(formData.get("oxygen")),
          bp: formData.get("bp"),
          patientId: selectedPatientId,
        }),
      });

      healthForm.reset();
      patientSelect.value = "";
      updateSelectedPatientId(patientSelect);

      showMessage(
        "health-message",
        `Health data saved successfully for ${data.patient.name}.`,
        "success"
      );
      renderAlerts(data.alerts, "new-alerts", "No alerts were created for this record.");
    } catch (error) {
      showMessage("health-message", error.message, "error");
    }
  });
};

const loadAlertsPage = async () => {
  try {
    const data = await apiRequest("/api/alerts");
    renderAlerts(data.alerts, "alerts-list", "No alerts found.");
  } catch (error) {
    showMessage("alerts-message", error.message, "error");
  }
};

const initAlertsPage = () => {
  const session = requireAuth();

  if (!session) {
    return;
  }

  const refreshButton = document.getElementById("refresh-alerts");

  if (refreshButton) {
    refreshButton.addEventListener("click", loadAlertsPage);
  }

  loadAlertsPage();
};

const initHistoryPage = async () => {
  const session = requireAuth();

  if (!session) {
    return;
  }

  const form = document.getElementById("history-form");
  const patientSelect = document.getElementById("patientId");

  if (!form || !patientSelect) {
    return;
  }

  const patients = await populatePatientSelect(
    "patientId",
    "history-message",
    "selected-history-patient-id"
  );

  if (session.user.role === "parent" || session.user.role === "child") {
    const assignedPatientId = session.user.patientId || "";

    if (!assignedPatientId) {
      showMessage("history-message", "No patient assigned to this user.", "error");
      patientSelect.disabled = true;
    } else {
      patientSelect.value = assignedPatientId;
      patientSelect.dispatchEvent(new Event("change"));
      patientSelect.disabled = true;
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    showMessage("history-message", "", "info");

    const patientId = patientSelect.value.trim();

    if (!patientId) {
      showMessage("history-message", "Please select a patient.", "error");
      return;
    }

    try {
      const data = await apiRequest(`/api/patient/${patientId}`);
      showMessage(
        "history-message",
        `Loaded history for ${data.patient.name}.`,
        "success"
      );
      renderHealthRecords(data.healthRecords, "history-list");
    } catch (error) {
      showMessage("history-message", error.message, "error");
    }
  });
};

const initEmergencyPage = () => {
  const session = requireAuth(["parent"]);

  if (!session) {
    return;
  }

  const button = document.getElementById("emergency-button");
  const details = document.getElementById("emergency-details");

  if (!button) {
    return;
  }

  button.addEventListener("click", () => {
    showMessage(
      "emergency-message",
      "Emergency action triggered. Please contact local emergency services immediately.",
      "error"
    );

    if (details) {
      details.classList.remove("hidden");
    }
  });
};

document.addEventListener("DOMContentLoaded", () => {
  renderNav();

  const page = document.body.dataset.page;

  switch (page) {
    case "login":
      initLoginPage();
      break;
    case "register":
      initRegisterPage();
      break;
    case "dashboard":
      initDashboardPage();
      break;
    case "add-health":
      initAddHealthPage();
      break;
    case "alerts":
      initAlertsPage();
      break;
    case "history":
      initHistoryPage();
      break;
    case "emergency":
      initEmergencyPage();
      break;
    default:
      break;
  }
});



