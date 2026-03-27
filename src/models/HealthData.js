const { Schema, model } = require("mongoose");

const healthDataSchema = new Schema({
  heartRate: {
    type: Number,
    required: true,
  },
  oxygen: {
    type: Number,
    required: true,
  },
  bp: {
    type: String,
    required: true,
    trim: true,
  },
  patientId: {
    type: Schema.Types.ObjectId,
    ref: "Patient",
    required: true,
  },
});

module.exports = model("HealthData", healthDataSchema);
