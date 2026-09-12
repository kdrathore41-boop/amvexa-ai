const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;
const ROOT = path.join(__dirname, "..");
const VERSION = "3.6";
const RELEASE = "1.0.1";

const FILES = {
  memory: path.join(__dirname, "memory.json"),
  tasks: path.join(__dirname, "tasks.json"),
  goals: path.join(__dirname, "goals.json"),
  context: path.join(__dirname, "context.json"),
  audit: path.join(__dirname, "audit.json"),
  knowledge: path.join(__dirname, "knowledge.json")
};

const MAX = {
  memory: 100,
  tasks: 100,
  goals: 50,
  audit: 200,
  knowledge: 100
};

app.use(cors());
app.use(express.json({ limit: "64kb" }));
app.disable("x-powered-by");

app.use((req, res, next) => {
  res.setHeader("X-Amvexa-Brain", VERSION);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

const buckets = new Map();

app.use((req, res, next) => {
  if (!req.path.startsWith("/api/")) return next();

  const key = req.ip || "unknown";
  const now = Date.now();
  const old = buckets.get(key) || [];
  const active = old.filter(t => now - t < 60000);

  if (active.length >= 60) {
    return res.status(429).json({
      success: false,
      error: "Rate limit reached. Try again shortly."
    });
  }

  active.push(now);
  buckets.set(key, active);
  next();
});

app.use(express.static(ROOT));

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch (_) {}
    return fallback;
  }
}

function writeJson(file, value) {
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    console.error("Write error:", e.message);
    return false;
  }
}

let memory = Array.isArray(readJson(FILES.memory, []))
  ? readJson(FILES.memory, [])
  : [];

let tasks = Array.isArray(readJson(FILES.tasks, []))
  ? readJson(FILES.tasks, [])
  : [];

let goals = Array.isArray(readJson(FILES.goals, []))
  ? readJson(FILES.goals, [])
  : [];

let audit = Array.isArray(readJson(FILES.audit, []))
  ? readJson(FILES.audit, [])
  : [];

let knowledge = Array.isArray(readJson(FILES.knowledge, []))
  ? readJson(FILES.knowledge, [])
  : [];

let context = readJson(FILES.context, {});

function saveAll() {
  writeJson(FILES.memory, memory.slice(-MAX.memory));
  writeJson(FILES.tasks, tasks.slice(-MAX.tasks));
  writeJson(FILES.goals, goals.slice(-MAX.goals));
  writeJson(FILES.audit, audit.slice(-MAX.audit));
  writeJson(FILES.knowledge, knowledge.slice(-MAX.knowledge));
  writeJson(FILES.context, context);
}

function logAction(tool, args, result) {
  audit.push({
    id: `audit_${Date.now()}`,
    at: new Date().toISOString(),
    tool,
    args: args || {},
    result: result || {}
  });

  audit = audit.slice(-MAX.audit);
  writeJson(FILES.audit, audit);
}

function remember(content, kind = "saved-memory") {
  const item = {
    id: `mem_${Date.now()}`,
    role: "memory",
    content: String(content),
    kind
