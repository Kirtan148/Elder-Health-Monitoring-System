const express = require("express");
const path = require("path");

const authRoutes = require("./routes/authRoutes");
const healthRoutes = require("./routes/healthRoutes");

const app = express();
const publicPath = path.join(__dirname, "..", "public");

app.use(express.json());
app.use(express.static(publicPath));

app.get("/", (req, res) => {
  res.redirect("/login.html");
});

app.use("/auth", authRoutes);
app.use("/api", healthRoutes);

module.exports = app;
