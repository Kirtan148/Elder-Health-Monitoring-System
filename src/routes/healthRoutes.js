const express = require("express");
const mongoose = require("mongoose");

const authMiddleware = require("../middleware/authMiddleware");
const allowRoles = require("../middleware/roleMiddleware");
const Alert = require("../models/Alert");
const HealthData = require("../models/HealthData");
const Patient = require("../models/Patient");

const router = express.Router();

const getPatientName = (value) => {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
};

const formatPatient = (patient) => ({
  _id: patient._id,
  name: patient.name,
});

const parseBloodPressure = (bp) => {
  if (typeof bp !== "string") {
    return null;
  }

  const [systolicValue, diastolicValue] = bp.split("/");
  const systolic = Number(systolicValue);
  const diastolic = Number(diastolicValue);

  if (Number.isNaN(systolic) || Number.isNaN(diastolic)) {
    return null;
  }

  return { systolic, diastolic };
};

const buildAlerts = ({ heartRate, oxygen, bp, patientId, healthDataId }) => {
  const alerts = [];
  const bloodPressure = parseBloodPressure(bp);

  if (heartRate < 50 || heartRate > 110) {
    alerts.push({
      patientId,
      healthDataId,
      type: "heartRate",
      severity: "alert",
      message: "Heart rate is out of the safe range",
    });
  }

  if (oxygen < 92) {
    alerts.push({
      patientId,
      healthDataId,
      type: "oxygen",
      severity: "critical",
      message: "Oxygen level is critical",
    });
  }

  if (bloodPressure && (bloodPressure.systolic > 140 || bloodPressure.diastolic > 90)) {
    alerts.push({
      patientId,
      healthDataId,
      type: "bp",
      severity: "warning",
      message: "Blood pressure is above the safe range",
    });
  }

  return alerts;
};

router.get("/health-data", authMiddleware, (req, res) => {
  res.json({
    message: "Sample elder health data",
    data: {
      heartRate: 72,
      bloodPressure: "120/80",
      temperature: 98.6,
    },
  });
});

router.get("/patients", authMiddleware, async (req, res) => {
  try {
    if (req.user.role === "care_manager") {
      const patients = await Patient.find().select("_id name").sort({ name: 1 });
      return res.json({ patients });
    }

    if (!req.user.patientId) {
      return res.status(400).json({ message: "No patient assigned to this user" });
    }

    const patient = await Patient.findById(req.user.patientId).select("_id name");

    if (!patient) {
      return res.status(404).json({ message: "Patient not found" });
    }

    res.json({ patients: [patient] });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/patients", authMiddleware, allowRoles("care_manager"), async (req, res) => {
  try {
    const name = getPatientName(req.body.name);

    if (!name) {
      return res.status(400).json({ message: "Patient name is required" });
    }

    const patient = await Patient.create({ name });

    res.status(201).json({
      message: "Patient added successfully",
      patient: formatPatient(patient),
    });
  } catch (error) {
    if (error.name === "ValidationError") {
      return res.status(400).json({ message: error.message });
    }

    res.status(500).json({ message: "Server error" });
  }
});

router.put("/patients/:id", authMiddleware, allowRoles("care_manager"), async (req, res) => {
  try {
    const { id } = req.params;
    const name = getPatientName(req.body.name);

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid patientId. Please select a patient from the list." });
    }

    if (!name) {
      return res.status(400).json({ message: "Patient name is required" });
    }

    const patient = await Patient.findByIdAndUpdate(
      id,
      { name },
      { new: true, runValidators: true }
    );

    if (!patient) {
      return res.status(404).json({ message: "Patient not found" });
    }

    res.json({
      message: "Patient updated successfully",
      patient: formatPatient(patient),
    });
  } catch (error) {
    if (error.name === "ValidationError") {
      return res.status(400).json({ message: error.message });
    }

    res.status(500).json({ message: "Server error" });
  }
});

router.get("/patient/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid patientId. Please select a patient from the list." });
    }

    if (req.user.role !== "care_manager") {
      if (!req.user.patientId) {
        return res.status(400).json({ message: "No patient assigned to this user" });
      }

      if (id !== String(req.user.patientId)) {
        return res.status(403).json({ message: "Access denied" });
      }
    }

    const patient = await Patient.findById(id).select("name email");

    if (!patient) {
      return res.status(404).json({ message: "Patient not found" });
    }

    const healthRecords = await HealthData.find({ patientId: patient._id });

    res.json({
      patient,
      healthRecords,
    });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/alerts", authMiddleware, async (req, res) => {
  try {
    if (req.user.role === "care_manager") {
      const alerts = await Alert.find();
      return res.json({ alerts });
    }

    if (!req.user.patientId) {
      return res.status(400).json({ message: "No patient assigned to this user" });
    }

    const alerts = await Alert.find({ patientId: req.user.patientId });

    res.json({ alerts });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/health-data", authMiddleware, allowRoles("care_manager"), (req, res) => {
  res.status(201).json({
    message: "Health data added successfully",
    addedBy: req.user.name,
  });
});

router.post("/health", authMiddleware, allowRoles("care_manager"), async (req, res) => {
  try {
    const { heartRate, oxygen, bp, patientId } = req.body;

    if (heartRate === undefined || oxygen === undefined || !bp || !patientId) {
      return res.status(400).json({ message: "All fields are required" });
    }

    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({ message: "Invalid patientId. Please select a patient from the list." });
    }

    const patient = await Patient.findById(patientId);

    if (!patient) {
      return res.status(404).json({ message: "Patient not found" });
    }

    const bloodPressure = parseBloodPressure(bp);

    if (!bloodPressure) {
      return res.status(400).json({ message: "BP must be in systolic/diastolic format" });
    }

    const healthData = await HealthData.create({
      heartRate,
      oxygen,
      bp,
      patientId: patient._id,
    });

    const alertsToCreate = buildAlerts({
      heartRate,
      oxygen,
      bp,
      patientId: patient._id,
      healthDataId: healthData._id,
    });

    const alerts = [];

    for (const alert of alertsToCreate) {
      const savedAlert = await Alert.create(alert);
      alerts.push(savedAlert);
    }

    res.status(201).json({
      message: "Health data added successfully",
      patient,
      healthData,
      alerts,
    });
  } catch (error) {
    if (error.name === "ValidationError") {
      return res.status(400).json({ message: error.message });
    }

    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;


