const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Patient = require("../models/Patient");
const User = require("../models/User");

const router = express.Router();

router.post("/register", async (req, res) => {
  try {
    const { name, email, password, role, patientId } = req.body;

    if (!name || !email || !password || !role) {
      return res.status(400).json({ message: "All fields are required" });
    }

    const normalizedEmail = email.toLowerCase();
    const normalizedPatientId = typeof patientId === "string" ? patientId.trim() : "";
    const needsPatientId = role === "parent" || role === "child";
    const existingUser = await User.findOne({ email: normalizedEmail });

    if (existingUser) {
      return res.status(400).json({ message: "User already exists" });
    }

    if (needsPatientId && !normalizedPatientId) {
      return res.status(400).json({ message: "Patient ID is required for parent and child accounts" });
    }

    if (normalizedPatientId && !mongoose.Types.ObjectId.isValid(normalizedPatientId)) {
      return res.status(400).json({ message: "Invalid patientId" });
    }

    let assignedPatient = null;

    if (needsPatientId) {
      assignedPatient = await Patient.findById(normalizedPatientId).select("_id");

      if (!assignedPatient) {
        return res.status(404).json({ message: "Patient not found" });
      }
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await User.create({
      name,
      email: normalizedEmail,
      password: hashedPassword,
      role,
      patientId: assignedPatient ? assignedPatient._id : undefined,
    });

    res.status(201).json({ message: "User registered successfully" });
  } catch (error) {
    if (error.name === "ValidationError") {
      return res.status(400).json({ message: error.message });
    }

    res.status(500).json({ message: "Server error" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    const normalizedEmail = email.toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const token = jwt.sign(
      {
        id: user._id,
        role: user.role,
        patientId: user.patientId ? String(user.patientId) : null,
      },
      process.env.JWT_SECRET
    );

    res.json({ token });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
