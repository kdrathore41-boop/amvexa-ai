const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    success: true,
    platform: "Amvexa",
    status: "online",
    message: "Amvexa AI backend is ready"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    platform: "Amvexa",
    status: "healthy"
  });
});

app.post("/api/chat", async (req, res) => {
  const message = String(req.body.message || "").trim();

  if (!message) {
    return res.status(400).json({
      success: false,
      error: "Message is required"
    });
  }

  res.json({
    success: true,
    assistant: "Amvexa",
    message: "I received your message. My AI brain is being connected.",
    received: message
  });
});

app.listen(PORT, () => {
  console.log(`Amvexa backend running on port ${PORT}`);
});
