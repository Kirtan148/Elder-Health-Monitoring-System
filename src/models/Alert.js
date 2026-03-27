const { Schema, model } = require("mongoose");

const alertSchema = new Schema({
  patientId: {
    type: Schema.Types.ObjectId,
    ref: "Patient",
    required: true,
  },
  healthDataId: {
    type: Schema.Types.ObjectId,
    ref: "HealthData",
    required: true,
  },
  type: {
    type: String,
    required: true,
    trim: true,
  },
  severity: {
    type: String,
    enum: ["alert", "critical", "warning"],
    required: true,
  },
  message: {
    type: String,
    required: true,
    trim: true,
  },
});

module.exports = model("Alert", alertSchema);
