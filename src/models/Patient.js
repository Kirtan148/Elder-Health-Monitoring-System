const { Schema, model } = require("mongoose");

const patientSchema = new Schema({
  _id: {
    type: Schema.Types.ObjectId,
    auto: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  email: {
    type: String,
    lowercase: true,
    trim: true,
  },
  userId: {
    type: Schema.Types.ObjectId,
    ref: "User",
    unique: true,
    sparse: true,
  },
});

module.exports = model("Patient", patientSchema);
