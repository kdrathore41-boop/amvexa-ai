const express = require("express");
const cors = require("cors");
const webpush = require("web-push");
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;
const ROOT = path.join(__dirname, "..");
const VERSION = "4.1.1";
const RELEASE = "1.2.0";

const PUSH_DATA_DIR = process.env.PUSH_DATA_DIR || __dirname;
try {
  fs.mkdirSync(PUSH_DATA_DIR, { recursive: true });
} catch (error) {
  console.error("Unable to create push data directory:", error?.message || error);
}

const FILES = {
  memory: path.join(__dirname, "memory.json"),
  tasks: path.join(__dirname, "tasks.json"),
  goals: path.join(__dirname, "goals.json"),
  context: path.join(__dirname, "context.json"),
  audit: path.join(__dirname, "audit.json"),
  knowledge: path.join(__dirname, "knowledge.json"),
  conversation: path.join(__dirname, "conversation.json"),
  intelligence: path.join(__dirname, "intelligence.json"),
  pushSubscriptions: path.join(PUSH_DATA_DIR, "push-subscriptions.json")
};

const MAX = {
  memory: 100,
  tasks: 100,
  goals: 50,
  audit: 200,
  knowledge: 100,
  conversation: 30,
  patterns: 100
};

app.use(cors());
app.use(express.json({ limit: "12mb" }));
app.disable("x-powered-by");

const buckets = new Map();

// Background Web Push support. VAPID keys must be supplied as Render environment variables.
const pushSubscriptions = new Map(Object.entries(readJson(FILES.pushSubscriptions, {})));
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:amvexa@example.com";
const PUSH_READY = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (PUSH_READY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn("Web Push disabled: VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY are not configured.");
}

function pushPayload(task) {
  return JSON.stringify({
    title: "Amvexa reminder",
    body: task.title,
    taskId: task.id,
    dueAt: task.dueAt || null,
    priority: task.priority || "normal"
  });
}

async function sendDueTaskPushes() {
  if (!PUSH_READY || !pushSubscriptions.size) return;
  const now = Date.now();
  for (const task of tasks) {
    if (task.status === "done" || !task.dueAt || task.pushNotifiedAt) continue;
    const due = Date.parse(task.dueAt);
    if (!Number.isFinite(due) || due > now) continue;
    for (const [key, subscription] of pushSubscriptions) {
      try {
        await webpush.sendNotification(subscription, pushPayload(task));
      } catch (error) {
        if (error?.statusCode === 404 || error?.statusCode === 410) {
          pushSubscriptions.delete(key);
          writeJson(FILES.pushSubscriptions, Object.fromEntries(pushSubscriptions));
        } else {
          console.error("Web Push error:", error?.message || error);
        }
      }
    }
    task.pushNotifiedAt = new Date().toISOString();
    writeJson(FILES.tasks, tasks);
  }
}

if (PUSH_READY) {
  setInterval(() => { sendDueTaskPushes().catch(error => console.error("Push scheduler error:", error?.message || error)); }, 30000);
}

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

app.post("/api/push/run", async (req, res) => {
  const expected = process.env.PUSH_CRON_SECRET || "";
  if (!expected || req.get("x-amvexa-cron-secret") !== expected) {
    return res.status(401).json({success:false, error:"Unauthorized"});
  }
  try {
    await sendDueTaskPushes();
    res.json({success:true, checkedAt:new Date().toISOString()});
  } catch (error) {
    res.status(500).json({success:false, error:"Push run failed"});
  }
});

app.get("/api/push/config", (req, res) => {
  res.json({success: true, enabled: PUSH_READY, publicKey: PUSH_READY ? VAPID_PUBLIC_KEY : null});
});

app.post("/api/push/subscribe", (req, res) => {
  if (!PUSH_READY) return res.status(503).json({success:false, error:"Web Push is not configured"});
  const subscription = req.body?.subscription;
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({success:false, error:"Invalid push subscription"});
  }
  pushSubscriptions.set(subscription.endpoint, subscription);
  writeJson(FILES.pushSubscriptions, Object.fromEntries(pushSubscriptions));
  res.json({success:true});
});

app.delete("/api/push/subscribe", (req, res) => {
  const endpoint = req.body?.endpoint;
  if (endpoint) {
    pushSubscriptions.delete(endpoint);
    writeJson(FILES.pushSubscriptions, Object.fromEntries(pushSubscriptions));
  }
  res.json({success:true});
});

app.use(express.static(ROOT, { maxAge: 0, etag: false, setHeaders: (res) => { res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate"); } }));

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

const PERSISTENCE_KEYS = new Map([
  [FILES.memory, "memory"], [FILES.tasks, "tasks"], [FILES.goals, "goals"],
  [FILES.context, "context"], [FILES.audit, "audit"], [FILES.knowledge, "knowledge"],
  [FILES.conversation, "conversation"], [FILES.intelligence, "intelligence"],
  [FILES.pushSubscriptions, "pushSubscriptions"]
]);

let persistencePool = null;
let persistenceStatus = { enabled: false, ready: false, error: null };
let persistenceReady = Promise.resolve();
let persistenceWriting = Promise.resolve();

function queuePersistentWrite(file, value) {
  const key = PERSISTENCE_KEYS.get(file);
  if (!key || !persistencePool || !persistenceStatus.ready) return;
  const snapshot = JSON.parse(JSON.stringify(value));
  persistenceWriting = persistenceWriting.catch(() => {}).then(async () => {
    try {
      await persistencePool.query(
        "INSERT INTO amvexa_state (state_key, state_value, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (state_key) DO UPDATE SET state_value = EXCLUDED.state_value, updated_at = NOW()",
        [key, JSON.stringify(snapshot)]
      );
    } catch (error) {
      persistenceStatus.error = error?.message || String(error);
      console.error("Persistent state write failed:", persistenceStatus.error);
    }
  });
}

async function initializePersistence() {
  const databaseUrl = process.env.DATABASE_URL || "";
  if (!databaseUrl) {
    persistenceStatus = { enabled: false, ready: true, error: "DATABASE_URL is not configured; using ephemeral local storage." };
    console.warn(persistenceStatus.error);
    return;
  }
  try {
    persistencePool = new Pool({
      connectionString: databaseUrl,
      max: 2,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000
    });
    await persistencePool.query(
      "CREATE TABLE IF NOT EXISTS amvexa_state (state_key TEXT PRIMARY KEY, state_value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    );
    const result = await persistencePool.query("SELECT state_key, state_value FROM amvexa_state");
    const stored = new Map(result.rows.map(row => [row.state_key, row.state_value]));
    if (stored.has("memory") && Array.isArray(stored.get("memory"))) memory = stored.get("memory");
    if (stored.has("tasks") && Array.isArray(stored.get("tasks"))) tasks = stored.get("tasks");
    if (stored.has("goals") && Array.isArray(stored.get("goals"))) goals = stored.get("goals");
    if (stored.has("context") && stored.get("context") && typeof stored.get("context") === "object") context = stored.get("context");
    if (stored.has("audit") && Array.isArray(stored.get("audit"))) audit = stored.get("audit");
    if (stored.has("knowledge") && Array.isArray(stored.get("knowledge"))) knowledge = stored.get("knowledge");
    if (stored.has("conversation") && Array.isArray(stored.get("conversation"))) conversation = stored.get("conversation");
    if (stored.has("intelligence") && stored.get("intelligence") && typeof stored.get("intelligence") === "object") intelligence = stored.get("intelligence");
    if (stored.has("pushSubscriptions") && stored.get("pushSubscriptions") && typeof stored.get("pushSubscriptions") === "object") {
      pushSubscriptions.clear();
      Object.entries(stored.get("pushSubscriptions")).forEach(([key,value]) => pushSubscriptions.set(key,value));
    }
    persistenceStatus = { enabled: true, ready: true, error: null };
    // Seed the database once when it is empty but local bundled state exists.
    const hasRows = result.rows.length > 0;
    if (!hasRows) {
      for (const [file, key] of PERSISTENCE_KEYS) {
        let value;
        if (key === "memory") value = memory;
        else if (key === "tasks") value = tasks;
        else if (key === "goals") value = goals;
        else if (key === "context") value = context;
        else if (key === "audit") value = audit;
        else if (key === "knowledge") value = knowledge;
        else if (key === "conversation") value = conversation;
        else if (key === "intelligence") value = intelligence;
        else if (key === "pushSubscriptions") value = Object.fromEntries(pushSubscriptions);
        if (value !== undefined) await persistencePool.query(
          "INSERT INTO amvexa_state (state_key, state_value, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (state_key) DO NOTHING",
          [key, JSON.stringify(value)]
        );
      }
    }
    console.log("Durable state persistence ready.");
  } catch (error) {
    persistenceStatus = { enabled: true, ready: true, error: error?.message || String(error) };
    console.error("Durable persistence initialization failed:", persistenceStatus.error);
  }
}

function writeJson(file, value) {
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
    queuePersistentWrite(file, value);
    return true;
  } catch (e) {
    console.error("Write error:", e.message);
    return false;
  }
}

let memory = Array.isArray(readJson(FILES.memory, [])) ? readJson(FILES.memory, []) : [];
let tasks = Array.isArray(readJson(FILES.tasks, [])) ? readJson(FILES.tasks, []) : [];
let goals = Array.isArray(readJson(FILES.goals, [])) ? readJson(FILES.goals, []) : [];
let audit = Array.isArray(readJson(FILES.audit, [])) ? readJson(FILES.audit, []) : [];
let knowledge = Array.isArray(readJson(FILES.knowledge, [])) ? readJson(FILES.knowledge, []) : [];
let context = readJson(FILES.context, {});
let conversation = Array.isArray(readJson(FILES.conversation, [])) ? readJson(FILES.conversation, []) : [];
let intelligence = readJson(FILES.intelligence, { version: 1, signals: [], patterns: [], preferences: [], stats: { messages: 0, taskRequests: 0, memoryRequests: 0, researchRequests: 0, planningRequests: 0 } });
if (!intelligence || typeof intelligence !== "object") intelligence = { version: 1, signals: [], patterns: [], preferences: [], stats: {} };

function saveAll() {
  writeJson(FILES.memory, memory.slice(-MAX.memory));
  writeJson(FILES.tasks, tasks.slice(-MAX.tasks));
  writeJson(FILES.goals, goals.slice(-MAX.goals));
  writeJson(FILES.audit, audit.slice(-MAX.audit));
  writeJson(FILES.knowledge, knowledge.slice(-MAX.knowledge));
  writeJson(FILES.context, context);
  writeJson(FILES.conversation, conversation.slice(-MAX.conversation));
  writeJson(FILES.intelligence, intelligence);
}

function logAction(tool, args, result) {
  audit.push({ id: `audit_${Date.now()}`, at: new Date().toISOString(), tool, args: args || {}, result: result || {} });
  audit = audit.slice(-MAX.audit);
  writeJson(FILES.audit, audit);
}

function remember(content, kind = "saved-memory") {
  const item = { id: `mem_${Date.now()}`, role: "memory", content: String(content), kind, importance: kind === "preference" ? 6 : 5, at: new Date().toISOString() };
  memory.push(item);
  memory = memory.slice(-MAX.memory);
  writeJson(FILES.memory, memory);
  return item;
}

function memorySearch(query, limit = 8) {
  const terms = String(query || "").toLowerCase().split(/\s+/).filter(x => x.length > 1);
  return memory.map(item => {
    const text = `${item.content} ${item.kind}`.toLowerCase();
    const score = terms.reduce((n, term) => n + (text.includes(term) ? 1 : 0), 0);
    return { item, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(x => x.item);
}

function recallContext(query) {
  const remembered = memorySearch(query, 8);
  const rememberTurns = conversation.filter(t => t.role === "user" && /(remember|save|store|note|yaad rakh|hamesha|always)/i.test(t.content)).slice(-8).map(t => t.content);
  return { remembered, rememberTurns };
}

function createGoalAndPlan(title) {
  const cleanTitle = String(title || "").trim();
  if (!cleanTitle) return { success:false, error:"Goal title is required" };
  let goal = goals.find(g => g.status !== "done" && String(g.title || "").toLowerCase() === cleanTitle.toLowerCase());
  if (!goal) {
    goal = { id:`goal_${Date.now()}`, title:cleanTitle, status:"open", createdAt:new Date().toISOString(), taskIds:[] };
    goals.push(goal);
  }
  const steps = [
    "Define the core capabilities and priorities for " + cleanTitle,
    "Verify the memory, task, reminder and autonomous execution workflow",
    "Plan the remaining integrations and proactive assistant behavior"
  ];
  // Keep the exact task objects created/reused in this call so the first
  // goal task cannot be lost between creation and execution.
  const plannedTasks = [];
  steps.forEach((step,index)=>{
    let task = tasks.find(t => t.status !== "done" && t.goalId === goal.id && t.title === step);
    if (!task) task = createTask(step, index === 0 ? "high" : "normal", null, goal.id);
    if (task && !task.goalId) task.goalId = goal.id;
    if (task) {
      goal.taskIds = Array.isArray(goal.taskIds) ? [...new Set([...goal.taskIds, task.id])] : [task.id];
      plannedTasks.push(task);
    }
  });
  goal.status = "open";
  writeJson(FILES.tasks, tasks);
  writeJson(FILES.goals, goals);
  const first = plannedTasks[0] || null;
  // Execute the exact task object created/reused above; do not re-resolve it by id.
  // This removes the last possible lookup/state mismatch in goal execution.
  let execution = {success:false,error:"First goal task was not created"};
  if (first) {
    const now = new Date().toISOString();
    first.status = "in_progress";
    first.startedAt = first.startedAt || now;
    first.lastExecutionAt = now;
    first.executionCount = (first.executionCount || 0) + 1;
    first.executionStep = "Execution started and task context activated.";
    writeJson(FILES.tasks, tasks);
    context.jarvis = {
      activeOperation: "execute_task",
      target: first.title,
      taskId: first.id,
      startedAt: now,
      status: "running"
    };
    writeJson(FILES.context, context);
    logAction("execute_task", { reference: first.id, taskId: first.id, source: "goal_execution" }, { success:true, executed:true, task:first });
    execution = {success:true, executed:true, task:first};
  }
  return { success:Boolean(execution.success), goal, tasks:goal.taskIds.map(id=>tasks.find(t=>t.id===id)).filter(Boolean), firstTask:execution.task||first, executed:Boolean(execution.executed), verified:Boolean(execution.success) };
}

function createTask(title, priority = "normal", dueAt = null, goalId = null) {
  const cleanTitle = String(title).trim();
  // Reusing the same reminder should update the existing open task instead of
  // creating duplicates. This also corrects an earlier reminder with a bad time.
  const existing = tasks.find(t => t.status !== "done" && t.title === cleanTitle);
  if (existing) {
    existing.priority = ["high", "normal", "low"].includes(priority) ? priority : existing.priority;
    if (dueAt) existing.dueAt = dueAt;
    if (goalId) existing.goalId = goalId;
    writeJson(FILES.tasks, tasks);
    return existing;
  }
  const task = { id: `task_${Date.now()}_${Math.random().toString(36).slice(2,8)}`, title: cleanTitle, priority: ["high", "normal", "low"].includes(priority) ? priority : "normal", status: "open", createdAt: new Date().toISOString(), ...(dueAt ? {dueAt} : {}), ...(goalId ? {goalId} : {}) };
  tasks.push(task); tasks = tasks.slice(-MAX.tasks); writeJson(FILES.tasks, tasks);
  if (goalId) {
    const goal = goals.find(g => g.id === goalId);
    if (goal) { goal.taskIds = Array.isArray(goal.taskIds) ? [...new Set([...goal.taskIds, task.id])] : [task.id]; goal.status = "open"; writeJson(FILES.goals, goals); }
  }
  return task;
}

function findTask(reference) {
  const text = String(reference || "").toLowerCase();
  return tasks.find(t => t.id === reference || t.title.toLowerCase() === text || t.title.toLowerCase().includes(text));
}

function normalizeTaskReference(message) {
  let text = String(message || "")
    .replace(/^\s*(?:please\s+)?(?:complete|finish|done|mark)\s+(?:the\s+)?(?:task|todo)\s*/i, "")
    .replace(/^\s*(?:is\s+)?(?:task|todo)\s*/i, "")
    .replace(/^\s*[:,-]+\s*/, "")
    .trim();

  // Natural completion commands often contain the task title first and
  // the completion instruction after it, e.g.:
  // "Amvexa test complete ho gaya, ise complete mark karo"
  // "Amvexa test complete हो गया, इसे complete mark करो"
  // Extract the title before the completion phrase so findTask() can match it.
  text = text
    // Natural completion confirmations may follow the task title directly:
    // "task title ho gaya, ise complete mark karo"
    .replace(/\s+(?:ho\s+gaya|ho\s+gayi|ho\s+gye|ह[ोो]\s*गया|ह[ोो]\s*गई|ह[ोो]\s*गए)[,\s]*(?:ise|इसे|isey)\s+(?:complete|done|finish)\s+(?:mark\s+)?(?:karo|kar\s+do|करो|कर\s*दो)\s*$/i, "")
    .replace(/\s+(?:complete|finished?|done)\s+(?:ho\s+gaya|ho\s+gayi|ho\s+gye|ह[ोो]\s*गया|ह[ोो]\s*गई|ह[ोो]\s*गए)[,\s]*(?:ise|इसे|isey)\s+(?:complete|done|finish)\s+(?:mark\s+)?(?:karo|kar\s+do|करो|कर\s*दो)\s*$/i, "")
    .replace(/\s+(?:complete|finished?|done)\s+(?:ho\s+gaya|ho\s+gayi|ho\s+gye|ह[ोो]\s*गया|ह[ोो]\s*गई|ह[ोो]\s*गए)\s*$/i, "")
    .replace(/\s+(?:complete|done|finish(?:ed)?)\s*(?:mark\s+)?(?:karo|kar\s+do|करो|कर\s*दो)\s*$/i, "")
    .trim();

  return text;
}

function executeTaskInternally(reference) {
  let task = findTask(reference);
  if (!task) {
    const openTasks = tasks.filter(t => t.status !== "done");
    if (openTasks.length === 1) task = openTasks[0];
  }
  if (!task) return { success: false, error: "Task not found" };
  if (task.status === "done") return { success: false, error: "Task already completed", task };
  const now = new Date().toISOString();
  task.status = "in_progress";
  task.startedAt = task.startedAt || now;
  task.lastExecutionAt = now;
  task.executionCount = (task.executionCount || 0) + 1;
  task.executionStep = "Execution started and task context activated.";
  writeJson(FILES.tasks, tasks);
  context.jarvis = {
    activeOperation: "execute_task",
    target: task.title,
    taskId: task.id,
    startedAt: now,
    status: "running"
  };
  writeJson(FILES.context, context);
  logAction("execute_task", { reference, taskId: task.id }, { success: true, executed: true, task });
  return { success: true, executed: true, task };
}

function postponeTask(reference, dueAt) {
  const task = findTask(reference);
  if (!task) return { success: false, error: "Task not found" };
  task.status = "open";
  task.dueAt = dueAt || null;
  task.pushNotifiedAt = null;
  task.postponedAt = new Date().toISOString();
  writeJson(FILES.tasks, tasks);
  return { success: true, task };
}

function completeTask(reference) {
  let task = findTask(reference);
  if (!task && /^(?:इस|उस|यह|वह)\s+(?:काम|टास्क|कार्य)/i.test(String(reference || ""))) {
    const openTasks = tasks.filter(t => t.status !== "done");
    if (openTasks.length === 1) task = openTasks[0];
  }
  if (!task) return { success: false, error: "Task not found" };
  task.status = "done"; task.completedAt = new Date().toISOString(); writeJson(FILES.tasks, tasks); syncGoals(); return { success: true, task };
}

function syncGoals() {
  let changed = false;
  goals = goals.map(goal => {
    if (!goal.taskIds) return goal;
    const done = goal.taskIds.filter(id => { const task = tasks.find(t => t.id === id); return task && task.status === "done"; }).length;
    const status = done === goal.taskIds.length ? "done" : "open";
    if (goal.status !== status) { changed = true; return { ...goal, status }; }
    return goal;
  });
  if (changed) writeJson(FILES.goals, goals);
}

function detectIntent(message) {
  const text = String(message || "").toLowerCase().trim();
  if (/^\s*(?:आज|aaj|today)\s*(?:का|के|की)?\s*(?:टास्क|काम|कार्य|tasks?|todos?)\s*(?:बताओ|बताइए|दिखाओ|दिखाइए|show|list)\s*[?।.!]*$/i.test(text) ||
      /^\s*(?:आज|aaj|today)\s+(?:मुझे|mujhe)\s+(?:क्या|kya)\s+(?:करना|karna)\s+(?:है|hai)\s*[?।.!]*$/i.test(text)) return "tasks";
  // Explicit assistant-mode requests take priority over every other intent.\n  // Recall questions must be checked before memory-save phrases so
  // "Mera naam kya hai?" is never treated as a request to save "kya".
  if (/^\s*(?:मेरा नाम|mera naam|my name)\s+(?:क्या(?:\s+है)?|kya(?:\s+hai)?|what(?:\s+is)?)\s*[?।.!]*$/i.test(text) || /\b(what do you remember|what do you know about me|what is my name|what's my name|who am i|recall|yaad hai|mere baare mein|mere baare me)\b/.test(text)) return "recall";
  // A reminder with a concrete date/time must always win over generic memory language.
  // Example: “आज शाम 7 बजे ... याद रखना” => reminder, not memory.
  const hasDateOrDay = /\b(aaj|today|kal|tomorrow|parso|day after tomorrow)\b|आज|कल|परसों/.test(text);
  const hasClockTime = /(?:\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b)|(?:\b\d{1,2}(?::\d{2})?\s*बजे)/i.test(text);
  const hasReminderPhrase = /\b(remind|reminder|yaad rakh(?:o|na)?)\b|याद\s*रख(?:ो|ना|िए)?|याद\s*दिलाना|याद\s*दिलाओ/i.test(text);
  if (hasDateOrDay && hasClockTime && hasReminderPhrase) return "reminder";
  if (/\b(remember|save|store|note|yaad rakh(?:o|na)?)\b/.test(text) || /\bmera naam\s+.+?(?:hai|yaad rakh)/i.test(text) || /\b(my name is)\b/i.test(text) || /मेरा नाम\s+.+?(?:है|याद रख|याद रखना|याद रखो)(?=\s|[।.!?]|$)/i.test(text) || /याद\s+रख(?:ो|ना|िए)?/i.test(text)) return "memory";
  if (/\b(remind|reminder|yaad dilana|yaad dila|याद दिलाना|याद दिलाओ|bhoolna mat|मत भूलना)\b/i.test(text)) return "reminder";
  // Goal execution must run before task-completion detection too: goal titles can contain words like "complete" and "task".
  if (/\b(goal|goals)\b/i.test(text) && /\b(chhote tasks|small tasks|break|todo|todo list|task|start|shuru|t todo|तोड़|टास्क|शुरू)\b/i.test(text) && /\b(personal ai assistant|personal assistant|amvexa|goal)\b/i.test(text)) return "goal_execution";
  if (/\b(complete|finish|mark)\b.*\b(task|todo)\b/.test(text) || /\b(task|todo)\b\s+.+\b(done|complete|finished)\b/.test(text) || /\b(done|complete|finished)\b\s+(?:the\s+)?(?:task|todo)\b/.test(text) || /(?:इस|उस|यह|वह)\s+(?:काम|टास्क|कार्य)\s+(?:को\s+)?(?:पूरा|पूर्ण|done|complete)\s*(?:करो|करें|मानो|मान लें|हुआ|हुई)?/i.test(text) || /(?:काम|टास्क|कार्य)\s+(?:पूरा|पूर्ण)\s*(?:करो|करें|मानो|मान लें|हुआ|हुई)?/i.test(text) || /\b(?:complete|finish|done)\b[\s\S]{0,80}\b(?:mark|complete|done)\b/i.test(text)) return "task_complete";
  // Goal execution must run before generic task/planning detection: the goal text itself contains "task".
  if (/\b(goal|goals)\b/i.test(text) && /\b(chhote tasks|small tasks|break|todo|todo list|task|start|shuru|t todo|तोड़|टास्क|शुरू)\b/i.test(text) && /\b(personal ai assistant|personal assistant|amvexa|goal)\b/i.test(text)) return "goal_execution";
  if (/\b(show|list|my|mere)\b.*\b(tasks?|todos?)\b/.test(text) || /(mere|aaj|aj|today|jaruri|zaroori|important).*(kaam|task|todo)/.test(text) || /(kaam|tasks?|todos?).*(batao|dikhao|dikhaiye|bataiye|show|list)/.test(text) || /(?:मुझे|मेरे|मेरा|आज|अभी|अपने)\s*(?:का|के|की)?\s*(?:सारे\s*)?(?:काम|टास्क|टूडू|कार्य)\s*(?:याद\s*दिलाओ|बता(?:ओ|इए)|दिखा(?:ओ|इए)|बताइए|दिखाइए)/i.test(text) || /(?:आज|अभी)\s*के?\s*(?:काम|टास्क|कार्य)/i.test(text)) return "tasks";
  if (/(?:^|\s)(?:ek|एक)?\s*(?:task|tast|todo|टास्क|कार्य)\s+(?:add|create|creat|banao|बनाओ|bana|बन|बना\s*दो|जोड़|जोड़)\s*(?:karo|karna|do|करो|करना|करें|दो)?(?=\s|[:;,.-]|$)/i.test(text) || /\b(?:add|create|creat|make|set|new)\s+(?:a\s+)?(?:task|tast|todo|टास्क|कार्य)\b/i.test(text) || /^\s*(?:kal|tomorrow|aaj|today|कल|आज)\b.+\b(?:karna|karne|complete|finish|niptana|niptane|करना|करने|पूरा|समाप्त)\b/i.test(text)) return "planning";
  if (/\b(play|listen|bajao|music|song|songs|gaana|gana|romantic|playlist|youtube)\b/.test(text)) return "music";
  if (/\b(research|search|latest|investigate|find out)\b/.test(text)) return "research";
  if (/\b(plan|schedule|organize)\b/.test(text) || /(aaj|aj|today).*(kaam|work|tasks?|todo|plan)/.test(text) || /(daily|din).*(plan|kaam|work)/.test(text)) return "planning";
  // Context-continuation phrases are explicit assistant-mode requests.
  // They should use the existing JARVIS state instead of falling into the
  // generic conversation/question fallback.
  if (/^(?:वो|उस|उस वाला|वही|वही वाला)\s+(?:काम|टास्क|काम को|टास्क को)?\s*(?:आगे|जारी|continue)?\s*(?:बढ़ाओ|बढ़ा(?:ओ|दो)|चलाओ|करो|कर दो|शुरू करो|जारी रखो|continue करो)?[.!?।\s]*$/i.test(text) ||
      /^(?:वो|वही|उस वाला)\s+(?:काम|टास्क)\s+(?:आगे|जारी)\s*(?:बढ़ाओ|बढ़ा दो|करो|रखो|चलाओ)?[.!?।\s]*$/i.test(text) ||
      /\b(?:continue|carry on|keep going)\b.*\b(?:that|the|same)\b.*\b(?:task|work)\b/i.test(text) ||
      /\b(?:that|same)\s+(?:task|work)\s+(?:continue|proceed|move forward)\b/i.test(text)) return "assistant_mode";
  if (/\b(personal ai assistant|personal assistant|jarvis|friday|sirf chat|just chat|next action|agla action|next step)\b/i.test(text) && /\b(goal|assistant|kaam|work|analyze|analyse|analyze karo|kaise kaam|how should you work|next action|next step|sirf chat|just chat)\b/i.test(text)) return "assistant_mode";
  if (/^\s*(?:khud\s+decide\s+karo(?:\s+aur\s+(?:test\s+shuru\s+karo|khud\s+start\s+karo))?|khud\s+decide\s+karna|khud\s+tay\s+karo|apne\s+aap\s+decide\s+karo(?:\s+aur\s+(?:test\s+shuru\s+karo|khud\s+start\s+karo))?|test\s+shuru\s+karo|khud\s+start\s+karo|start\s+the\s+test|decide\s+yourself\s+and\s+start)\s*[.!?]*$/i.test(text)) return "autonomous_action";
  if (/\b(hello|hi|hey|namaste)\b/.test(text)) return "greeting";
  if (/\b(what|why|how|when|where|who|which|can you|do you|are you|tum|aap|kya|kyun|kaise|kab|kahan|kaun|hai|ho)\b/.test(text)) return "question";
  return "conversation";
}

function extractMemory(message) {
  const text = String(message || "").trim();
  const identity = text.match(/^\s*(?:mera naam|my name|मेरा नाम)\s+(.+?)(?:\s+(?:hai|is|h|है)\b|\s+(?:yaad rakh(?:o|na)?|याद रख(?:ो|ना|िए)?)\b|\s*[।.!?]|$)/i);
  if (identity) return "User ka naam " + identity[1].trim();
  return text.replace(/^\s*(remember|save|store|note|yaad rakh(?:o|na)?|याद रख(?:ो|ना|िए)?)\s*(this|that|ye|yah|ki|यह|ये|कि)?\s*[:,-]?\s*/i, "").trim();
}

function extractDueAt(message) {
  const text=String(message||"").toLowerCase();
  if (!/\b(aaj|today|kal|tomorrow|parso|day after tomorrow)\b|आज|कल|परसों/.test(text)) return null;

  // Always interpret reminders in India Standard Time, independent of Render's server timezone.
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());
  const get=p=>parts.find(x=>x.type===p)?.value;
  let year=Number(get("year")), month=Number(get("month")), day=Number(get("day"));

  const dayShift=/\b(kal|tomorrow)\b|कल/.test(text) ? 1 : /\b(parso|day after tomorrow)\b|परसों/.test(text) ? 2 : 0;
  const base=new Date(Date.UTC(year,month-1,day));
  base.setUTCDate(base.getUTCDate()+dayShift);
  year=base.getUTCFullYear(); month=base.getUTCMonth()+1; day=base.getUTCDate();

  // Prefer an explicit clock time: 7 बजे / 7:30 / 7 pm / 19:00.
  const timeMatch=text.match(/(?:\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b)|(?:\b(\d{1,2})(?::(\d{2}))?\s*बजे)/i);
  let hour=timeMatch ? Number(timeMatch[1]||timeMatch[4]) : null;
  const minute=timeMatch ? Number(timeMatch[2]||timeMatch[5]||0) : 0;
  const meridiem=timeMatch?.[3]?.toLowerCase() || null;
  const evening=/(?:\b(?:raat|night|evening)\b|शाम|रात)/.test(text);
  if(hour!==null){
    if(meridiem==="pm" && hour<12) hour+=12;
    if(meridiem==="am" && hour===12) hour=0;
    if(!meridiem && evening && hour<12) hour+=12;
  }else{
    hour=evening ? 19 : 18;
  }
  hour=Math.max(0,Math.min(23,hour));
  return new Date(Date.UTC(year,month-1,day,hour,minute)-330*60*1000).toISOString();
}

function taskFromMessage(message) {
  let title = String(message || "").trim();  title = title.replace(/^\s*[“"']?\s*(?:(?:ek|एक)\s+)?(?:task|tast|todo|टास्क|कार्य)\s+(?:add|create|creat|banao|बनाओ|bana|बन|बना\s*दो|जोड़|जोड़)\s*(?:karo|karna|do|करो|करना|करें|दो)?(?=\s|[:;,.-]|$)\s*[,;:\-]?\s*/i, "");
  title = title.replace(/^\s*[“"']?\s*(?:add|create|creat|make|set|new)\s+(?:a\s+)?(?:task|tast|todo|टास्क|कार्य)\b\s*(?:karo|karna|do|करो|करना|करें|दो)?\s*[,;:\-]?\s*/i, "");
  title = title.replace(/^\s*(?:करो|करना|करें|दो|do|karo|karna)\s+/i, ""); title = title.replace(/[”"']\s*$/, "").trim();
  return title;
}

function nextAction() { const open=tasks.filter(t=>t.status!=="done"); const now=Date.now(); const activeGoals=goals.filter(g=>g.status!=="done"); const due=open.filter(t=>t.dueAt).sort((a,b)=>new Date(a.dueAt)-new Date(b.dueAt)); const overdue=due.find(t=>new Date(t.dueAt).getTime()<=now); const dueSoon=due.find(t=>{const ms=new Date(t.dueAt).getTime()-now;return ms>0&&ms<=60*60*1000;}); const high=open.find(t=>t.priority==="high"); const linkedGoalTask=open.find(t=>t.goalId&&activeGoals.some(g=>g.id===t.goalId)); const pick=overdue||dueSoon||high||linkedGoalTask||due[0]||open[0]; if(pick)return {type:"task",title:pick.title,taskId:pick.id,priority:pick.priority,dueAt:pick.dueAt||null,goalId:pick.goalId||null,reason:overdue?"overdue":dueSoon?"due_soon":high?"high_priority":linkedGoalTask?"active_goal":"next_due",overdue:Boolean(pick.dueAt&&new Date(pick.dueAt).getTime()<=now)}; const goal=activeGoals[0]; if(goal)return {type:"goal",title:goal.title||goal.name||"active goal",goalId:goal.id||null,reason:"active_goal_without_task"}; return {type:"setup",title:"Create your first task or goal"}; }
function dailyPlan() { const now=Date.now(); const items=tasks.filter(t=>t.status!=="done").sort((a,b)=>{const pa={high:0,normal:1,low:2}[a.priority]??1,pb={high:0,normal:1,low:2}[b.priority]??1; const da=a.dueAt?new Date(a.dueAt).getTime():Infinity,db=b.dueAt?new Date(b.dueAt).getTime():Infinity; return (da-now)-(db-now)||pa-pb;}).slice(0,5); return {generatedAt:new Date().toISOString(),tasks:items,nextAction:nextAction()}; }
function contextSummary() { return { memoryCount: memory.length, taskCount: tasks.length, openTasks: tasks.filter(t => t.status !== "done").length, goalCount: goals.length, knowledgeCount: knowledge.length }; }

// JARVIS/FRIDAY operating state: context -> priority -> next action -> execution -> verification -> learning.
function jarvisContext() {
  const now = new Date();
  const openTasks = tasks.filter(t => t.status !== "done");
  const activeGoals = goals.filter(g => g.status !== "done");
  const highPriority = openTasks.filter(t => t.priority === "high");
  const dueSoon = openTasks.filter(t => t.dueAt).filter(t => { const ms = new Date(t.dueAt).getTime() - now.getTime(); return ms > 0 && ms <= 60 * 60 * 1000; });
  const overdue = openTasks.filter(t => t.dueAt && new Date(t.dueAt).getTime() <= now.getTime());
  const activeGoal = activeGoals[0] || null;
  const goalTaskIds = Array.isArray(activeGoal?.taskIds) ? activeGoal.taskIds : [];
  const goalOpenTasks = goalTaskIds.filter(id => openTasks.some(t => t.id === id));
  const goalCompletedTasks = goalTaskIds.filter(id => tasks.some(t => t.id === id && t.status === "done"));
  const goalProgress = goalTaskIds.length ? Math.round((goalCompletedTasks.length / goalTaskIds.length) * 100) : 0;
  return { mode:"JARVIS/FRIDAY", currentTime:{iso:now.toISOString(),local:now.toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})}, situation:{openTasks:openTasks.length,highPriorityTasks:highPriority.length,dueSoonTasks:dueSoon.length,overdueTasks:overdue.length,activeGoal:activeGoal?{id:activeGoal.id,title:activeGoal.title||activeGoal.name||"active goal",openLinkedTasks:goalOpenTasks.length,completedLinkedTasks:goalCompletedTasks.length,totalLinkedTasks:goalTaskIds.length,progressPercent:goalProgress}:null}, context:contextSummary(), activeGoals:activeGoals.slice(-10), openTasks:openTasks.slice(-10), highPriorityTasks:highPriority.slice(-10), nextAction:nextAction(), learning:intelligenceSnapshot(), principle:"Understand context, choose the next useful operation, execute only through verified tools, then learn from the result." };
}

function updatePersonalAlgorithm(message, intent) {
  const text = String(message || "").trim();
  if (!text) return intelligence;
  const lower = text.toLowerCase();
  intelligence.stats = intelligence.stats || {};
  intelligence.stats.messages = (intelligence.stats.messages || 0) + 1;
  const counterMap = { task_complete: "taskRequests", tasks: "taskRequests", create_task: "taskRequests", planning: "planningRequests", memory: "memoryRequests", research: "researchRequests" };
  if (counterMap[intent]) intelligence.stats[counterMap[intent]] = (intelligence.stats[counterMap[intent]] || 0) + 1;

  const signals = [];
  if (/\b(urgent|important|jaruri|zaroori|jaldi|asap|deadline|target)\b/i.test(lower)) signals.push("priority_sensitive");
  if (/\b(yaad|remember|hamesha|always)\b/i.test(lower)) signals.push("memory_or_continuity");
  if (/\b(kal|tomorrow|aaj|today|deadline|date|tarikh|parso|day after tomorrow)\b/i.test(lower)) signals.push("time_sensitive");
  if (/\b(next|agla|aage|continue|next step)\b/i.test(lower)) signals.push("next_step_oriented");
  if (/\b(plan|planning|organize|schedule|routine)\b/i.test(lower)) signals.push("planning_oriented");
  if (/\b(research|search|latest|current|find out)\b/i.test(lower)) signals.push("research_oriented");
  if (/\b(normal|casual|baat|bore|chat)\b/i.test(lower) && intent === "conversation") signals.push("conversation_mode");

  const now = new Date().toISOString();
  signals.forEach(signal => {
    const existing = intelligence.patterns.find(p => p.key === signal);
    if (existing) {
      existing.count = (existing.count || 0) + 1;
      existing.lastSeen = now;
    } else {
      intelligence.patterns.push({ key: signal, count: 1, confidence: 0.25, firstSeen: now, lastSeen: now });
    }
  });
  intelligence.patterns = intelligence.patterns.slice(-MAX.patterns);
  intelligence.patterns.forEach(p => {
    p.confidence = Math.min(0.95, 0.25 + Math.min(0.70, (p.count || 1) * 0.05));
  });

  if (/\b(hindi|हिंदी|hinglish)\b/i.test(lower)) {
    if (!intelligence.preferences.includes("Hindi/Hinglish preferred")) intelligence.preferences.push("Hindi/Hinglish preferred");
  }
  if (/\b(no|nahi|nahin)\b.*\b(story|long|generic|repeat|repetition)\b/i.test(lower)) {
    if (!intelligence.preferences.includes("Avoid unnecessary repetition and long explanations")) intelligence.preferences.push("Avoid unnecessary repetition and long explanations");
  }

  intelligence.signals.push({ id: "sig_" + Date.now(), at: now, intent, signals });
  intelligence.signals = intelligence.signals.slice(-MAX.patterns);
  writeJson(FILES.intelligence, intelligence);
  return intelligence;
}

function personalAlgorithmContext() {
  const patterns = (intelligence.patterns || []).filter(p => p.count >= 2).sort((a,b) => (b.count || 0) - (a.count || 0)).slice(0, 10);
  const prefs = (intelligence.preferences || []).slice(-10);
  const stats = intelligence.stats || {};
  return [
    "Personal Algorithm Intelligence:",
    patterns.length ? "Observed patterns: " + patterns.map(p => p.key + " (" + p.count + " signals, confidence " + Math.round((p.confidence || 0) * 100) + "%)").join(", ") : "Observed patterns: still learning",
    prefs.length ? "Preferences: " + prefs.join("; ") : "Preferences: still learning",
    "Interaction stats: " + JSON.stringify(stats),
    "Use these patterns to personalize planning, tone and next-step suggestions. Do not invent patterns or claim certainty. Never manipulate the user."
  ].join("\n");
}

function intelligenceSnapshot() {
  return {
    version: intelligence.version || 1,
    patterns: (intelligence.patterns || []).map(({key,count,confidence,lastSeen}) => ({key,count,confidence,lastSeen})),
    preferences: intelligence.preferences || [],
    stats: intelligence.stats || {}
  };
}
function addConversation(role, content) { conversation.push({ id: `turn_${Date.now()}_${Math.random().toString(36).slice(2,7)}`, role, content: String(content || "").slice(0,5000), at: new Date().toISOString() }); conversation = conversation.slice(-MAX.conversation); writeJson(FILES.conversation, conversation); }
function conversationContext(limit = 12) { return conversation.slice(-limit).map(turn => ({ role: turn.role === "assistant" ? "model" : "user", parts: [{ text: turn.content }] })); }

async function generateAIResponse(message, extraContext = "", useWeb = false) {
  const apiKey = process.env.GEMINI_API_KEY; if (!apiKey) return { success:false, error:"AI provider is not configured" };
  const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  const system = ["You are Amvexa, a personal AI assistant for one user.","You are not a command parser. Hold a natural, continuous conversation.","Do not bring up an older task, topic, question, or plan unless the current message clearly refers to it.","If the user asks for normal/casual conversation, reply naturally and briefly; do not turn it into task planning.","You are Amvexa, the user's own personal assistant software. Never claim that Amazon, Google, OpenAI, or another company created you unless the user explicitly asks about the underlying model/provider.","Understand Hindi, Hinglish and English and normally reply in natural Hindi/Hinglish unless the user asks otherwise.","Be concise but thoughtful. Do not repeat generic greetings or ask what you can do after every message.","Use recent conversation context and relevant remembered facts.","Never claim an action happened unless the execution result confirms it.","When current information is needed, use supplied web research rather than inventing facts.","You may suggest the next useful step when appropriate, without being pushy.","Operate with a JARVIS/FRIDAY-style loop: understand context, plan, execute, monitor, verify and learn. Be proactive when the next action is clear, but do not fabricate actions.","Use the Personal Algorithm Intelligence supplied below to adapt to the user. Treat it as learned signals, not absolute truth.","Low-risk internal planning can proceed without repeated confirmation; consequential external actions require confirmation.",extraContext].filter(Boolean).join("\n");
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { method:"POST", body:JSON.stringify({ system_instruction:{parts:[{text:system}]}, contents:conversationContext(), ...(useWeb?{tools:[{google_search:{}}]}:{}), generationConfig:{temperature:0.7,maxOutputTokens:700} }), headers:{"Content-Type":"application/json","x-goog-api-key":apiKey}, signal:controller.signal });
    const data = await response.json().catch(()=>({})); if(!response.ok){ const providerError=data?.error?.message||"AI provider request failed"; console.error("Gemini error:",response.status,providerError); return {success:false,error:providerError}; }
    const text=data?.candidates?.[0]?.content?.parts?.map(p=>p.text||"").join("").trim(); if(!text){ console.error("Gemini returned no text:",JSON.stringify(data).slice(0,2000)); return {success:false,error:"AI provider returned no response"}; }
    return {success:true,text};
  } catch(error){ return {success:false,error:error?.name==="AbortError"?"AI provider timed out":"AI provider unavailable"}; } finally{clearTimeout(timeout);}
}

async function buildAssistantResponse(message, toolResult, useWeb=false) { const memoryContext=memorySearch(message,5).map(m=>m.content).join("\n"); const webContext=toolResult?.success&&toolResult?.results?.length?toolResult.results.slice(0,6).map(r=>`${r.title}\n${r.content}\n${r.url}`).join("\n\n"):""; const state=jarvisContext(); const extra=[personalAlgorithmContext(),`JARVIS/FRIDAY operating state:\n${JSON.stringify(state)}`,memoryContext?`Relevant remembered facts:\n${memoryContext}`:"",webContext?`Fresh web research:\n${webContext}`:""].filter(Boolean).join("\n\n"); return generateAIResponse(message,extra,useWeb); }

async function webSearch(query) {
  const apiKey=process.env.TAVILY_API_KEY; if(!apiKey)return {success:false,error:"Web intelligence is not configured",results:[]};
  const controller=new AbortController(); const timeout=setTimeout(()=>controller.abort(),12000);
  try{ const response=await fetch("https://api.tavily.com/search",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({api_key:apiKey,query:String(query||"").trim()+( /\b(news|khabar|today|aaj|latest|current|recent)\b/i.test(String(query||""))?" Give the answer in Hindi. For each story, include the source name and publication date when available.":" Answer in Hindi."),search_depth:"advanced",max_results:6,include_answer:true,include_raw_content:false}),signal:controller.signal}); const data=await response.json().catch(()=>({})); if(!response.ok)return {success:false,error:data?.detail||data?.message||"Web search failed",results:[]}; return {success:true,answer:data?.answer||"",results:Array.isArray(data?.results)?data.results.map(item=>({title:item.title||"",url:item.url||"",content:String(item.content||"").slice(0,2500),score:item.score,published_date:item.published_date||item.publishedAt||item.date||""})):[]}; }catch(error){return {success:false,error:error?.name==="AbortError"?"Web search timed out":"Web search unavailable",results:[]};}finally{clearTimeout(timeout);}
}
function formatWebResponse(result){ if(!result?.success)return result?.error==="Web intelligence is not configured"?"Web intelligence abhi connected nahi hai. TAVILY_API_KEY configure hone ke baad main live internet research kar sakta hoon.":"Web research abhi complete nahi ho payi."; const lines=[]; if(result.answer)lines.push(result.answer.trim()); if(result.results?.length){lines.push("","Sources:"); result.results.forEach((item,index)=>{lines.push((index+1)+". "+(item.title||item.url));if(item.published_date)lines.push("   Date: "+item.published_date);if(item.url)lines.push("   Source: "+item.url);});} return lines.join("\n"); }
function knowledgeSearch(query){ const terms=String(query||"").toLowerCase().split(/\s+/).filter(x=>x.length>1); return knowledge.map(item=>{const text=`${item.name} ${item.text}`.toLowerCase();const score=terms.reduce((n,term)=>n+(text.includes(term)?1:0),0);return {item,score};}).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,8).map(x=>({id:x.item.id,name:x.item.name,text:x.item.text.slice(0,2000),score:x.score})); }
function planTool(message){ const intent=detectIntent(message); if(intent==="assistant_mode" && /^(?:वो|उस|उस वाला|वही|वही वाला)\s+(?:काम|टास्क|काम को|टास्क को)?\s*(?:आगे|जारी|continue)?\s*(?:बढ़ाओ|बढ़ा(?:ओ|दो)|चलाओ|करो|कर दो|शुरू करो|जारी रखो|continue करो)?[.!?।\s]*$/i.test(String(message||"").trim())) return {tool:"continue_context",args:{}}; if(intent==="goal_execution"){ const title=String(message).replace(/^\s*(?:mera|my)\s+goal\s+(?:hai|is)\s*/i,"").replace(/\s*\.\s*khud.*$/i,"").trim() || "Complete personal AI assistant"; return {tool:"create_goal_and_plan",args:{title}}; } if(intent==="autonomous_action") return {tool:"jarvis_autonomous_step",args:{}}; if(intent==="memory"){const content=/\b(hindi|हिंदी)\b/i.test(message)?"Mujhe hamesha Hindi mein jawab dena hai.":extractMemory(message);return {tool:"save_memory",args:{content,kind:/\b(hindi|हिंदी)\b/i.test(message)?"preference":"saved-memory"}};} if(intent==="recall")return {tool:"recall_memory",args:{query:message}}; if(intent==="task_complete")return {tool:"complete_task",args:{reference:normalizeTaskReference(message)}}; if(intent==="music")return {tool:"music_search",args:{query:message}}; if(intent==="reminder"){const title=message.replace(/\b(remind me to|remind me|reminder|yaad dilana|yaad dila|याद दिलाना|याद दिलाओ|bhoolna mat|मत भूलना)\b/ig,"").replace(/^[\s:,-]+/,"").trim(); return title?{tool:"create_task",args:{title:"Reminder: "+title,priority:"high",dueAt:extractDueAt(message)}}:{tool:null,args:{}};} if(intent==="tasks")return {tool:"get_tasks",args:{}}; if(intent==="planning"){let title=taskFromMessage(message); const isExplicitTask=/(?:^|\s)(?:ek|एक)?\s*(?:task|tast|todo|टास्क|कार्य)\s+(?:add|create|creat|banao|बनाओ|bana|बन|बना\s*दो|जोड़|जोड़)\s*(?:karo|karna|do|करो|करना|करें|दो)?(?=\s|[:;,.-]|$)/i.test(message)||/\b(?:add|create|creat|make|set|new)\s+(?:a\s+)?(?:task|tast|todo|टास्क|कार्य)\b/i.test(message); const isImplicitTask=/^\s*(?:kal|tomorrow|aaj|today|कल|आज)\b.+\b(?:karna|karne|karna hai|करना|करने|करना है|dekhna|देखना|देखना है|chahiye|चाहिए|complete|finish|niptana|niptane|पूरा|समाप्त)\b/i.test(message); if(isImplicitTask&&!isExplicitTask) title=message.replace(/^\s*(?:kal|tomorrow|aaj|today|कल|आज)\b\s*/i,"").replace(/^\s*(?:subah|morning|dopahar|afternoon|shaam|evening|raat|night|सुबह|दोपहर|शाम|रात)\b\s*/i,"").replace(/^\s*\d{1,2}(?::\d{2})?\s*(?:am|pm|बजे)?\s*/i,"").replace(/^\s*mujhe\s+/i,"").trim(); if((isExplicitTask||isImplicitTask)&&title)return {tool:"create_task",args:{title,priority:/\b(high|urgent|important|jaruri|zaroori)\b/i.test(message)?"high":"normal",dueAt:extractDueAt(message)}}; return {tool:"get_daily_plan",args:{}};} if(intent==="research"||/\b(news|khabar|latest|current|recent|source|sources|date|tarikh|internet|web|online)\b/i.test(message))return {tool:null,args:{}}; }
async function executeTool(tool,args={}){ let result; switch(tool){case"create_goal_and_plan":result=createGoalAndPlan(args.title);break;case"jarvis_autonomous_step":result=autonomousStep();break;case"execute_task":result=executeTaskInternally(args.reference);break;case"postpone_task":result=postponeTask(args.reference,args.dueAt);break;case"save_memory":result={success:true,memory:remember(args.content,args.kind||"saved-memory")};break;case"recall_memory":result={success:true,memories:memorySearch(args.query)};break;case"create_task":result={success:true,task:createTask(args.title,args.priority,args.dueAt,args.goalId)};break;case"continue_context":result=continueContext();break;case"complete_task":result=completeTask(args.reference);break;case"music_search":result={success:true,action:{type:"music",query:String(args.query||"").trim()||"romantic songs",url:"https://youtube.com/playlist?list=PL-ER7jNwYADztaCaTFnTMGBoGWaIUQ0K4&si=6o-Ln9w2WHvlUKgt",playlist:true}};break;case"get_tasks":result={success:true,tasks};break;case"get_daily_plan":result={success:true,plan:dailyPlan()};break;case"get_next_action":result={success:true,nextAction:nextAction()};break;case"search_knowledge":result={success:true,results:knowledgeSearch(args.query)};break;case"web_search":result=await webSearch(args.query);break;default:return {success:false,error:"Tool not allowed"};} logAction(tool,args,result); return result; }
function verifyTool(tool,result){
  if(!result||result.success!==true)return {verified:false,reason:result?.error||"Tool failed"};
 if(tool==="create_goal_and_plan")return {verified:Boolean(result.goal&&result.firstTask&&result.executed),reason:"Goal decomposition and first task execution verified"}; if(tool==="continue_context")return {verified:Boolean(result.continued===true||result.type==="setup"),reason:"Active context continuation state verified"};
 if(tool==="create_task"){const id=result.task?.id;const task=tasks.find(t=>t.id===id);return {verified:Boolean(id&&task&&task.status!=="done"),reason:"Created task verified"};}
 if(tool==="jarvis_autonomous_step")return {verified:Boolean(result.executed&&result.verified),reason:"Autonomous internal step verified"}; if(tool==="postpone_task")return {verified:Boolean(result.task&&result.task.dueAt),reason:"Task reschedule verified"}; if(tool==="execute_task"){const id=result.task?.id;const task=tasks.find(t=>t.id===id);return {verified:Boolean(result.executed&&task&&(task.status==="in_progress"||task.status==="done")),reason:"Task execution start verified"};} if(tool==="save_memory")return {verified:Boolean(result.memory?.id),reason:"Memory record verified"}; if(tool==="create_task"){const id=result.task?.id;const task=tasks.find(t=>t.id===id);return {verified:Boolean(id&&task&&task.status!=="done"),reason:"Created task verified"};} if(tool==="complete_task"){const id=result.task?.id;const task=tasks.find(t=>t.id===id);return {verified:Boolean(task&&task.status==="done"),reason:"Task completion verified"};}
 if(tool==="get_tasks")return {verified:Array.isArray(result.tasks),reason:"Task list structure verified"};
 if(tool==="get_daily_plan")return {verified:Boolean(result.plan&&Array.isArray(result.plan.tasks)&&result.plan.nextAction),reason:"Daily plan structure verified"};
 if(tool==="get_next_action")return {verified:Boolean(result.nextAction&&result.nextAction.type),reason:"Next action structure verified"};
 if(tool==="recall_memory")return {verified:Array.isArray(result.memories),reason:"Memory search structure verified"};
 if(tool==="search_knowledge")return {verified:Array.isArray(result.results),reason:"Knowledge search structure verified"};
 return {verified:true,reason:"Result structure verified"};
}

function buildDecision(next){
  const base={
    operation:"setup",
    target:next?.title||"Create your first task or goal",
    taskId:null,
    goalId:null,
    reason:"no_active_work",
    priority:"normal",
    dueAt:null,
    overdue:false,
    safeToExecute:true,
    requiresUserAction:false
  };
  if(next?.type==="task"){
    return {...base,operation:"work_on_task",target:next.title,taskId:next.taskId||null,goalId:next.goalId||null,reason:next.reason||"next_action",priority:next.priority||"normal",dueAt:next.dueAt||null,overdue:Boolean(next.overdue),safeToExecute:false,requiresUserAction:true};
  }
  if(next?.type==="goal"){
    return {...base,operation:"plan_goal",target:next.title,goalId:next.goalId||null,reason:next.reason||"active_goal_without_task"};
  }
  return base;
}

function decisionNeedsUserAction(decision){
  return Boolean(decision && decision.requiresUserAction);
}

function decisionSummary(decision){
  if(!decision) return "No decision available.";
  const urgency=decision.overdue?"overdue":decision.priority==="high"?"high priority":decision.dueAt?"deadline set":"normal";
  return decision.operation+" · "+urgency+" · "+decision.target;
}function autonomousStep() {
  const state = jarvisContext();
  const next = state.nextAction;
  const decision = buildDecision(next);
  const operation = next?.type === "task"
    ? "Start work on the active task"
    : next?.type === "goal"
      ? "Plan the next concrete goal action"
      : "Prepare the first useful internal action";
  const result = {
    success: true,
    executed: true,
    operation,
    target: decision.target,
    decision,
    firstStep: next?.type === "task"
      ? "Active task context captured; execution plan initialized."
      : next?.type === "goal"
        ? "Active goal context captured; next concrete action initialized."
        : "No active work found; setup is the next operation.",
    verified: true,
    verifiedAt: new Date().toISOString()
  };
  logAction("jarvis_autonomous_step", { decision }, result);
  context.jarvis = {
    activeOperation: operation,
    target: decision.target,
    startedAt: result.verifiedAt,
    status: "running"
  };
  writeJson(FILES.context, context);
  updatePersonalAlgorithm("autonomous execution step: " + decision.target, "autonomous_action");
  return result;
}

function localBrain(message, reason = "") {
  const intent = detectIntent(message);
  const next = nextAction();
  if (intent === "greeting") return "नमस्ते जी। Amvexa यहाँ है।";
  if (intent === "question") return "मैंने आपकी बात समझी। AI backend इस समय उपलब्ध नहीं है, लेकिन मेरा local brain और आपकी saved memory/tasks अभी भी active हैं।";
  if (intent === "conversation") return "जी Kapil, ठीक है। अभी कोई active काम नहीं है। मैं यहीं हूँ—आप जब चाहें बात शुरू कर सकते हैं, और जरूरत पड़ते ही मैं अगला useful step पकड़ लूँगा।";
  if (intent === "planning") return next.type === "task"
    ? "आपके खुले काम में अगला action: " + next.title
    : "अभी कोई active task नहीं है। हम पहला concrete task तय कर सकते हैं।";
  if (intent === "tasks") {
    const open = tasks.filter(t => t.status !== "done");
    return open.length ? "आपके active tasks:\n" + open.map((t,i) => (i+1) + ". " + t.title).join("\n") : "अभी कोई active task नहीं है।";
  }
  if (intent === "recall") {
    const found = memorySearch(message, 5);
    return found.length ? found.map((m,i) => (i+1) + ". " + m.content).join("\n") : "Matching memory अभी नहीं मिली।";
  }
  return "मैंने आपका command समझ लिया, लेकिन AI backend अभी उपलब्ध नहीं है। " + (reason ? "Connection fallback active है।" : "");
}

function continueContext() {
  const state = jarvisContext();
  const next = state.nextAction;
  const now = new Date().toISOString();
  const recentUser = conversation.filter(t => t.role === "user").slice(-5).map(t => t.content);
  if (next?.type === "task") {
    context.jarvis = {
      activeOperation: "continue_task_context",
      target: next.title,
      taskId: next.taskId || null,
      goalId: next.goalId || null,
      startedAt: now,
      status: "context_continued",
      source: "explicit_user_continuation"
    };
    writeJson(FILES.context, context);
    updatePersonalAlgorithm("continued active task context: " + next.title, "assistant_mode");
    return {success:true,continued:true,type:"task",target:next.title,taskId:next.taskId||null,goalId:next.goalId||null,reason:next.reason||"next_action",recentContext:recentUser.slice(-3)};
  }
  if (next?.type === "goal") {
    context.jarvis = {
      activeOperation: "continue_goal_context",
      target: next.title,
      goalId: next.goalId || null,
      startedAt: now,
      status: "context_continued",
      source: "explicit_user_continuation"
    };
    writeJson(FILES.context, context);
    updatePersonalAlgorithm("continued active goal context: " + next.title, "assistant_mode");
    return {success:true,continued:true,type:"goal",target:next.title,goalId:next.goalId||null,reason:next.reason||"active_goal_without_task",recentContext:recentUser.slice(-3)};
  }
  return {success:true,continued:false,type:"setup",target:"No active task or goal",reason:"no_active_work",recentContext:recentUser.slice(-3)};
}

function assistantModeFallback() {
  const open = tasks.filter(t => t.status !== "done");
  if (open.length) return "Mera operating mode clear hai: context samajhna → priority nikalna → action lena → execution verify karna → seekhna.\n\nAbhi next action: " + open[0].title + ".";
  const goal = goals.find(g => g.status !== "done");
  if (goal) return "Mera operating mode clear hai: main goal ko execution mein rakhoonga, sirf chat mein nahi.\n\nAbhi next action: " + (goal.title || goal.name || "active goal") + ".";
  const priorGoal = conversation.slice(-20).some(t => /\b(goal|target)\b/i.test(t.content) && /\b(personal ai assistant|propveda|sales|5 sales|27 days)\b/i.test(t.content));
  if (priorGoal) return "Mera operating mode clear hai: context → priority → action → execution → verification → learning.\n\nAbhi next action: active goal ko execution track mein lana aur pehla concrete task set karna.";
  return "Mera operating mode clear hai: context → priority → action → execution → verification → learning.\n\nAbhi next action: ek active goal register karna, taaki main aage usse track karke aapko baar-baar repeat na karwaun.";
}

app.use((req,res,next)=>{
  if (!req.path.startsWith("/api/")) return next();
  // Never block API requests on durable-state initialization.
  // Render/DB startup can be slow; in-memory state remains available.
  next();
});

app.get("/api/health", (req,res)=>res.json({success:true,service:"amvexa-ai",version:VERSION,release:RELEASE,persistence:persistenceStatus}));
app.get("/api/memory", (req,res)=>res.json({success:true,memory}));
app.get("/api/tasks", (req,res)=>res.json({success:true,tasks}));
app.get("/api/context", (req,res)=>res.json({success:true,context:contextSummary()}));
app.get("/api/conversation", (req,res)=>res.json({success:true,conversation:conversation.slice(-MAX.conversation)}));
app.get("/api/intelligence", (req,res)=>res.json({success:true,intelligence:intelligenceSnapshot()}));
app.get("/api/jarvis", (req,res)=>res.json({success:true,state:jarvisContext()}));
app.get("/api/autonomous-talk", async (req,res)=>{
  const state=jarvisContext();
  const recent=conversation.slice(-10).map(t=>({role:t.role,content:String(t.content||"").slice(0,700)}));
  const activeTasks=tasks.filter(t=>t.status!=="done").slice(0,5).map(t=>({title:t.title,priority:t.priority,dueAt:t.dueAt||null,status:t.status}));
  const activeGoals=goals.filter(g=>g.status!=="done").slice(0,3).map(g=>({title:g.title||g.name,status:g.status}));
  const prompt=`You are Amvexa, Kapil's proactive personal AI companion. This is an autonomous check-in: the user has not spoken for a while, so YOU chose to start the conversation.
Speak naturally in Hindi/Hinglish, respectful "aap". Maximum 2 short sentences.
Use the current context and recent conversation to choose ONE useful, human reason to speak.
Do not repeat the previous assistant message or a generic "main ready hoon" line.
If there is an active task/goal, mention a concrete next step or useful observation.
If there is no active work, start a meaningful light conversation based on the recent context instead of asking "what should we do?".
Do not invent facts, actions, memories, or external events. Do not claim to have completed anything.
Return only the spoken message.

Current state:
${JSON.stringify({situation:state.situation,nextAction:state.nextAction,activeTasks,activeGoals,context:contextSummary(),recent})}`;
  const ai=await generateAIResponse(prompt, "", false);
  let message=ai.success ? String(ai.text||"").trim() : "";
  if(!message){
    const next=state.nextAction;
    const lastUser=conversation.filter(t=>t.role==="user").slice(-1)[0]?.content||"";
    if(next?.type==="task") message="Kapil, aapka agla useful kaam abhi \"" + next.title + "\" hai—chahein to main isi context se aage badh sakta hoon.";
    else if(next?.type==="goal") message="Kapil, aapka goal abhi active hai. Main uske next concrete step ko context mein rakhe hue hoon.";
    else if(/नहीं.*काम|koi.*kaam.*nahi|no.*work/i.test(lastUser)) message="ठीक है Kapil, अभी task नहीं है। थोड़ी normal baat karte hain—jo bhi aapke dimaag mein chal raha hai, wahi se shuru karte hain.";
    else message="Kapil, main yahin hoon. Abhi koi urgent kaam nahi hai, to main context ko dhyan mein rakhkar aapse naturally baat kar sakta hoon.";
  }
  res.json({success:true,shouldSpeak:Boolean(message),message,source:ai.success?"ai":"local",checkedAt:new Date().toISOString(),state:{nextAction:state.nextAction,activeTasks:activeTasks.length,activeGoals:activeGoals.length}});
});
app.get("/api/proactive",(req,res)=>{
  const open=tasks.filter(t=>t.status!=="done");
  const high=open.filter(t=>t.priority==="high");
  const activeGoals=goals.filter(g=>g.status!=="done");
  const next=nextAction();
  const decision=buildDecision(next);
  const now=Date.now();
  const dueSoonTasks=open.filter(t=>t.dueAt).filter(t=>{const ms=new Date(t.dueAt).getTime()-now; return ms>0 && ms<=60*60*1000;});
  const activeGoal=activeGoals[0]||null;
  const goalTaskCount=activeGoal?.taskIds?.length||0;
  const goalOpenTaskCount=activeGoal?.taskIds?.filter(id=>open.some(t=>t.id===id)).length||0;

  let signal=null;
  const dueSoon=next && next.dueAt && !next.overdue && (()=>{const ms=new Date(next.dueAt).getTime()-Date.now(); return ms>0 && ms<=60*60*1000;})();
  if(dueSoon){
    const dueTime=new Date(next.dueAt).toLocaleTimeString("en-IN",{timeZone:"Asia/Kolkata",hour:"2-digit",minute:"2-digit"});
    signal={type:"deadline_soon",priority:"high",reason:"task_due_soon",message:"Aapka kaam 1 ghante ke andar due hai: " + next.title + " (" + dueTime + ")",suggestedAction:{type:"task",taskId:next.taskId,title:next.title}};
  }else if(next.overdue){
    signal={type:"deadline",priority:"high",reason:"task_overdue",message:"Deadline nikal chuki hai: " + next.title,suggestedAction:{type:"task",taskId:next.taskId,title:next.title}};
  }else if(high.length){
    const priorityTask=next?.type==="task" && next.priority==="high" ? next : high[0];
    signal={type:"priority",priority:"high",reason:"high_priority_task_pending",message:"Aapka high-priority kaam pending hai: " + priorityTask.title,suggestedAction:{type:"task",taskId:priorityTask.taskId||priorityTask.id,title:priorityTask.title}};
  }else if(open.length){
    signal={type:"next_action",priority:"normal",reason:"next_action_available",message:"Agla useful kaam ready hai: " + next.title,suggestedAction:{type:"task",taskId:next.taskId||null,title:next.title}};
  }else if(activeGoals.length){
    const goalTitle=activeGoals[0].title||activeGoals[0].name||"active goal";
    signal={type:"goal_followup",priority:"normal",reason:"active_goal_without_open_task",message:"Aapka goal active hai. Main uska next concrete task set kar sakta hoon: " + goalTitle,suggestedAction:{type:"goal_followup",goalId:activeGoals[0].id||null}};
  }

  const shouldSpeak=Boolean(signal && (signal.priority==="high" || signal.type==="goal_followup" || signal.type==="next_action"));
  const checkedAt=new Date().toISOString();
  res.json({success:true,shouldSpeak,message:signal?.message||"",signal,nextAction:next,decision,checkedAt,context:{openTasks:open.length,highPriorityTasks:high.length,activeGoals:activeGoals.length,dueSoonTasks:dueSoonTasks.length,activeGoal:activeGoal?{id:activeGoal.id,title:activeGoal.title||activeGoal.name||"active goal",taskCount:goalTaskCount,openTaskCount:goalOpenTaskCount}:null,checkedAt}});
});

// ── Cognitive Brain Layer ──────────────────────────────────────────────────
// Human-inspired cognitive architecture layered on top of the AI model.
// This is a simulation of cognitive processes, not a claim of consciousness.
const COGNITIVE_VERSION = 1;
const cognitiveBrain = {
  version: COGNITIVE_VERSION,
  attention: null,
  workingMemory: [],
  lastObservationAt: null,
  lastDecisionAt: null,
  lastLearningAt: null,
  signalFingerprint: null,
  signalCount: 0,
  learningEvents: 0
};

function cognitiveNow() {
  return new Date().toISOString();
}

function cognitiveRecentContext(limit=8) {
  return conversation.slice(-limit).map(t => ({
    role:t.role,
    content:String(t.content||"").slice(0,500),
    at:t.at
  }));
}

function cognitiveObserve() {
  const now=Date.now();
  const open=tasks.filter(t=>t.status!=="done");
  const activeGoals=goals.filter(g=>g.status!=="done");
  const overdue=open.filter(t=>t.dueAt && Date.parse(t.dueAt)<=now);
  const dueSoon=open.filter(t=>{
    if(!t.dueAt) return false;
    const ms=Date.parse(t.dueAt)-now;
    return Number.isFinite(ms) && ms>0 && ms<=2*60*60*1000;
  });
  const high=open.filter(t=>t.priority==="high");
  const recentUser=conversation.filter(t=>t.role==="user").slice(-3);
  const recentAssistant=conversation.filter(t=>t.role==="assistant").slice(-2);
  const jarvis=context?.jarvis||{};
  return {
    at:cognitiveNow(),
    environment:{
      openTasks:open.length,
      highPriority:high.length,
      overdue:overdue.length,
      dueSoon:dueSoon.length,
      activeGoals:activeGoals.length
    },
    focus:{
      next:nextAction(),
      activeGoal:activeGoals[0]||null,
      jarvis
    },
    recent:{
      user:recentUser,
      assistant:recentAssistant
    },
    memoryCount:memory.length,
    knowledgeCount:knowledge.length,
    learned:intelligenceSnapshot()
  };
}

function cognitiveAttend(observation) {
  const candidates=[];
  const add=(type,score,target,reason,data={})=>candidates.push({type,score,target,reason,...data});
  const next=observation.focus.next;
  if(observation.environment.overdue) add("deadline",100,next?.title||"overdue task","deadline passed",{urgency:"critical"});
  if(observation.environment.dueSoon) add("deadline_soon",90,next?.title||"due soon task","deadline approaching",{urgency:"high"});
  if(observation.environment.highPriority) add("priority",75,next?.title||"high-priority task","important unfinished work",{urgency:"high"});
  if(observation.environment.activeGoals) add("goal",55,observation.focus.activeGoal?.title||"active goal","goal needs progress",{urgency:"normal"});
  if(observation.environment.openTasks) add("next_action",40,next?.title||"next action","open work available",{urgency:"normal"});
  const lastUser=observation.recent.user.at(-1)?.content||"";
  if(lastUser && /(help|madad|problem|pareshan|confused|samajh|urgent|jaldi|tension)/i.test(lastUser)){
    add("emotional_context",85,lastUser,"recent user context needs attention",{urgency:"high"});
  }
  candidates.sort((a,b)=>b.score-a.score);
  return candidates[0]||{type:"idle",score:0,target:null,reason:"nothing currently requires attention",urgency:"low"};
}

function cognitiveDecide(observation,attention) {
  const fingerprint=[attention.type,attention.target||"",observation.environment.openTasks,observation.environment.overdue,observation.environment.dueSoon].join("|");
  const recentSame=cognitiveBrain.signalFingerprint===fingerprint;
  const quietWindow=attention.type==="idle" ? true : false;
  let action="observe";
  let speak=false;
  if(!quietWindow){
    action=attention.type==="deadline"||attention.type==="deadline_soon" ? "proactive_alert"
      : attention.type==="emotional_context" ? "contextual_support"
      : attention.type==="priority"||attention.type==="next_action"||attention.type==="goal" ? "proactive_guidance"
      : "observe";
    speak=!recentSame && attention.score>=55;
  }
  return {action,speak,fingerprint,reason:attention.reason};
}

function cognitiveLearn(event) {
  cognitiveBrain.learningEvents++;
  cognitiveBrain.lastLearningAt=cognitiveNow();
  const key=event?.type||"unknown";
  const existing=(intelligence.patterns||[]).find(p=>p.key==="cognitive_"+key);
  if(existing){
    existing.count=(existing.count||0)+1;
    existing.confidence=Math.min(0.95,0.25+Math.min(0.70,existing.count*0.05));
    existing.lastSeen=cognitiveBrain.lastLearningAt;
  }else{
    intelligence.patterns.push({key:"cognitive_"+key,count:1,confidence:0.25,firstSeen:cognitiveBrain.lastLearningAt,lastSeen:cognitiveBrain.lastLearningAt});
  }
  intelligence.patterns=intelligence.patterns.slice(-MAX.patterns);
  writeJson(FILES.intelligence,intelligence);
}

function runCognitiveCycle() {
  const observation=cognitiveObserve();
  const attention=cognitiveAttend(observation);
  const decision=cognitiveDecide(observation,attention);
  cognitiveBrain.attention=attention;
  cognitiveBrain.workingMemory=cognitiveRecentContext();
  cognitiveBrain.lastObservationAt=observation.at;
  cognitiveBrain.lastDecisionAt=observation.at;
  cognitiveBrain.signalFingerprint=decision.fingerprint;
  cognitiveBrain.signalCount++;
  context.cognitiveBrain={
    version:COGNITIVE_VERSION,
    attention,
    decision,
    workingMemory:cognitiveBrain.workingMemory,
    lastObservationAt:cognitiveBrain.lastObservationAt,
    lastDecisionAt:cognitiveBrain.lastDecisionAt,
    learningEvents:cognitiveBrain.learningEvents
  };
  writeJson(FILES.context,context);
  return {observation,attention,decision};
}

// ── Always-On Brain ───────────────────────────────────────────────────────
// Server-side observation; no microphone is kept open.
let brainBusy = false;
let brainLastRunAt = null;
let brainLastTalkAt = null;
let brainLastSignal = null;
const BRAIN_INTERVAL_MS = 60 * 1000;
const BRAIN_TALK_COOLDOWN_MS = 5 * 60 * 1000;

function brainState() {
  return {active:true, intervalMs:BRAIN_INTERVAL_MS, lastRunAt:brainLastRunAt, lastTalkAt:brainLastTalkAt, lastSignal:brainLastSignal, pushReady:PUSH_READY, subscribers:pushSubscriptions.size};
}

async function sendBrainPush(message, signal) {
  if (!PUSH_READY || !pushSubscriptions.size) return;
  const payload = JSON.stringify({title:"Amvexa",body:message,brain:true,signal:signal?.type||"proactive",at:new Date().toISOString()});
  for (const [key, subscription] of pushSubscriptions) {
    try { await webpush.sendNotification(subscription, payload); }
    catch (error) {
      if (error?.statusCode === 404 || error?.statusCode === 410) pushSubscriptions.delete(key);
      else console.error("Brain Web Push error:", error?.message || error);
    }
  }
  writeJson(FILES.pushSubscriptions, Object.fromEntries(pushSubscriptions));
}

async function runBrainCycle() {
  if (brainBusy) return;
  brainBusy = true;
  brainLastRunAt = new Date().toISOString();
  try {
    const cognition=runCognitiveCycle();
    const open=tasks.filter(t=>t.status!=="done");
    const high=open.filter(t=>t.priority==="high");
    const next=nextAction();
    const now=Date.now();
    const cognitiveAttention=cognition.attention;
    const cognitiveDecision=cognition.decision;
    const dueSoon=next?.dueAt && !next.overdue && (() => {
      const ms=Date.parse(next.dueAt)-now;
      return Number.isFinite(ms) && ms>0 && ms<=60*60*1000;
    })();
    let signal=null;
    if(next?.overdue) signal={type:"deadline",priority:"high",reason:"task_overdue",target:next.title};
    else if(dueSoon) signal={type:"deadline_soon",priority:"high",reason:"task_due_soon",target:next.title};
    else if(high.length) { const task=next?.type==="task"&&next.priority==="high"?next:high[0]; signal={type:"priority",priority:"high",reason:"high_priority_task_pending",target:task.title}; }
    else if(open.length) signal={type:"next_action",priority:"normal",reason:"next_action_available",target:next?.title||open[0].title};
    else {
      const goal=goals.find(g=>g.status!=="done");
      if(goal) signal={type:"goal_followup",priority:"normal",reason:"active_goal",target:goal.title||goal.name||"active goal"};
    }
    if(cognitiveAttention.type!=="idle" && cognitiveDecision.action!=="observe"){
      signal = signal || {
        type:cognitiveAttention.type,
        priority:cognitiveAttention.urgency==="critical"||cognitiveAttention.urgency==="high"?"high":"normal",
        reason:cognitiveAttention.reason,
        target:cognitiveAttention.target
      };
    }
    brainLastSignal=signal;
    if(!signal) return;
    const last=brainLastTalkAt?Date.parse(brainLastTalkAt):0;
    if(last && now-last<BRAIN_TALK_COOLDOWN_MS) return;
    if(!cognitiveDecision.speak && cognitiveAttention.type!=="deadline" && cognitiveAttention.type!=="deadline_soon") return;

    const state=jarvisContext();
    const prompt=`You are Amvexa, Kapil's proactive personal AI assistant.
This is an autonomous background check. Speak only because the signal below is useful.
Use respectful Hindi/Hinglish ("aap"). Maximum 2 short sentences.
Be concrete and natural. Do not invent actions or claim completion.
Do not say "main ready hoon" or ask a generic "kya karna hai?".
Signal: ${JSON.stringify(signal)}
State: ${JSON.stringify({nextAction:state.nextAction,situation:state.situation,activeGoals:state.activeGoals?.slice(0,3),highPriorityTasks:state.highPriorityTasks?.slice(0,5)})}`;
    const ai=await generateAIResponse(prompt,"",false);
    let message=ai.success?String(ai.text||"").trim():"";
    if(!message){
      if(signal.type==="deadline") message="Kapil, aapka task \"" + signal.target + "\" overdue hai.";
      else if(signal.type==="deadline_soon") message="Kapil, \"" + signal.target + "\" agle 1 ghante mein due hai.";
      else if(signal.type==="priority") message="Kapil, aapka high-priority task \"" + signal.target + "\" abhi pending hai.";
      else if(signal.type==="next_action") message="Kapil, next useful action \"" + signal.target + "\" ready hai.";
      else message="Kapil, aapka goal active hai: \"" + signal.target + "\".";
    }
    addConversation("assistant",message);
    cognitiveLearn({type:cognitiveAttention.type,target:cognitiveAttention.target});
    brainLastTalkAt=new Date().toISOString();
    await sendBrainPush(message,signal);
    context.jarvis={...(context.jarvis||{}),backgroundBrain:{status:"spoken",at:brainLastTalkAt,signal:signal.type,target:signal.target,message}};
    writeJson(FILES.context,context);
  } catch(error) {
    console.error("Background brain cycle error:",error?.message||error);
  } finally { brainBusy=false; }
}

app.get("/api/brain/status",(req,res)=>res.json({success:true,brain:brainState(),cognitive:{version:COGNITIVE_VERSION,attention:cognitiveBrain.attention,workingMemory:cognitiveBrain.workingMemory,lastObservationAt:cognitiveBrain.lastObservationAt,lastDecisionAt:cognitiveBrain.lastDecisionAt,learningEvents:cognitiveBrain.learningEvents}}));

app.post("/api/jarvis/execute", async (req,res)=>{
  const state=jarvisContext();
  const decision=buildDecision(state.nextAction);
  if(decision.operation!=="work_on_task"){
    return res.json({success:true,executed:false,reason:"No active task available",decision,state,checkedAt:new Date().toISOString()});
  }
  const result=executeTaskInternally(decision.taskId);
  const verification=verifyTool("execute_task",result);
  return res.json({success:Boolean(verification.verified),executed:Boolean(result.executed),action:"task_execution_started",decision,result,verification,nextAction:jarvisContext().nextAction,checkedAt:new Date().toISOString()});
});

app.get("/api/jarvis/decision",(req,res)=>{
  const state=jarvisContext();
  const next=state.nextAction;
  const decision=next?.type==="task"
    ? {operation:"work_on_task",target:next.title,taskId:next.taskId||null,goalId:next.goalId||null,reason:next.reason||"next_action",safeToExecute:false,requiresUserAction:true}
    : next?.type==="goal"
      ? {operation:"plan_goal",target:next.title,taskId:null,goalId:next.goalId||null,reason:next.reason||"active_goal_without_task",safeToExecute:true,requiresUserAction:false}
      : {operation:"setup",target:next?.title||"Create your first task or goal",taskId:null,goalId:null,reason:"no_active_work",safeToExecute:true,requiresUserAction:false};
  res.json({success:true,decision,state,checkedAt:new Date().toISOString()});
});

app.post("/api/jarvis/step", async (req,res)=>{
  const state=jarvisContext();
  const next=state.nextAction;
  if(!next || next.type==="setup"){
    const goal=state.activeGoals?.find(g=>g.status!=="done");
    if(goal){
      const title="Goal: "+(goal.title||goal.name||"active goal")+" — पहला concrete action तय करना";
      const result=await executeTool("create_task",{title,priority:"high",goalId:goal.id});
      const verification=verifyTool("create_task",result);
      updatePersonalAlgorithm("jarvis step goal to task", "planning");
      const verifiedState = jarvisContext();
      return res.json({
        success:true,
        action:"create_task",
        result,
        verification,
        nextAction:verifiedState.nextAction,
        situation:verifiedState.situation,
        learning:verifiedState.learning
      });
    }
    return res.json({success:true,action:"none",result:{message:"No safe internal action available"},verification:{verified:true,reason:"Nothing to execute"},nextAction:next});
  }
  const decision = {operation:next.type === "task" ? "work_on_task" : next.type, target:next.title, taskId:next.taskId || null, goalId:next.goalId || null, reason:next.reason || "next_action", safeToExecute:false, requiresUserAction:next.type === "task"};
  updatePersonalAlgorithm("jarvis decision: "+next.title+" ["+(next.reason||"next_action")+"]", "next-step");
  const verifiedState=jarvisContext();
  res.json({success:true,action:"decision_ready",decision,result:{nextAction:verifiedState.nextAction,situation:verifiedState.situation},verification:{verified:true,reason:"Decision and current situation state verified"},nextAction:verifiedState.nextAction,learning:intelligenceSnapshot()});
});


app.post("/api/voice/transcribe", async (req,res)=>{
  const apiKey=process.env.GEMINI_API_KEY;
  if(!apiKey)return res.status(503).json({success:false,error:"AI provider is not configured"});
  const audio=String(req.body?.audio||"").trim();
  const mimeType=String(req.body?.mimeType||"audio/webm").split(";")[0];
  if(!audio)return res.status(400).json({success:false,error:"Audio is required"});
  if(audio.length>11000000)return res.status(413).json({success:false,error:"Audio is too large"});
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),45000);
  let stage="decode";
  try{
    // Gemini 3.5 Transcribe expects uploaded audio/file URI rather than inline base64.
    const audioBytes=Buffer.from(audio,"base64");
    stage="upload_setup";
    const startUpload=await fetch("https://generativelanguage.googleapis.com/upload/v1beta/files",{
      method:"POST",
      headers:{
        "x-goog-api-key":apiKey,
        "X-Goog-Upload-Protocol":"resumable",
        "X-Goog-Upload-Command":"start",
        "X-Goog-Upload-Header-Content-Length":String(audioBytes.length),
        "X-Goog-Upload-Header-Content-Type":mimeType,
        "Content-Type":"application/json"
      },
      body:JSON.stringify({file:{display_name:"amvexa-voice"}}),
      signal:controller.signal
    });
    if(!startUpload.ok){
      const detail=await startUpload.text().catch(()=> "");
      return res.status(502).json({success:false,error:"Gemini file upload setup failed: "+(detail||startUpload.status),stage});
    }
    const uploadUrl=startUpload.headers.get("x-goog-upload-url");
    if(!uploadUrl)return res.status(502).json({success:false,error:"Gemini upload URL was not returned",stage});
    stage="audio_upload";
    const upload=await fetch(uploadUrl,{
      method:"POST",
      headers:{
        "Content-Length":String(audioBytes.length),
        "X-Goog-Upload-Offset":"0",
        "X-Goog-Upload-Command":"upload, finalize"
      },
      body:audioBytes,
      signal:controller.signal
    });
    const fileData=await upload.json().catch(()=>({}));
    if(!upload.ok||!fileData?.file?.uri){
      return res.status(502).json({success:false,error:"Gemini audio upload failed: "+(fileData?.error?.message||upload.status),stage});
    }
    stage="transcription";
    stage="transcription";
    // Use Gemini's documented generateContent transcription path with the uploaded file URI.
    const interaction=await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-transcribe:generateContent",{
      method:"POST",
      headers:{"Content-Type":"application/json","x-goog-api-key":apiKey},
      body:JSON.stringify({
        contents:[{
          parts:[{
            fileData:{fileUri:fileData.file.uri,mimeType}
          }]
        }],
        generationConfig:{
          audioTranscriptionConfig:{mode:"SMART"}
        }
      }),
      signal:controller.signal
    });
    const data=await interaction.json().catch(()=>({}));
    if(!interaction.ok){
      return res.status(502).json({success:false,error:"Gemini transcription failed: "+(data?.error?.message||interaction.status),stage});
    }
    stage="parse_response";
    const transcript=String(
      data?.candidates?.[0]?.content?.parts?.map(p=>p?.text||"").join(" ") ||
      data?.text ||
      ""
    ).trim();
    if(!transcript)return res.status(502).json({success:false,error:"Gemini returned no transcript",stage});
    return res.json({success:true,transcript});
  }catch(error){
    const message=error?.name==="AbortError"?"Voice transcription timed out":(error?.message||"Voice transcription unavailable");
    console.error("Voice transcription error:", {stage, name:error?.name, message});
    return res.status(502).json({success:false,error:`Voice transcription failed at ${stage}: ${message}`,stage});
  }finally{clearTimeout(timeout);}
});
app.post("/api/chat", async (req,res)=>{
  const message=String(req.body?.message||"").trim();
  if(!message)return res.status(400).json({success:false,error:"Message is required"});
  addConversation("user",message);
  const detectedIntent = detectIntent(message);
  // A single user message can contain multiple independent intents.
  // Split the common "remember my name + set a reminder" pattern so memory
  // is stored and the reminder is created as two separate verified actions.
  // Compound intent: a single message may contain both a memory request and a reminder.
  // Keep these two actions independent so identity text can never leak into the reminder title.
  const hasIdentity = /(?:^|[\s।.!?,])(?:मेरा नाम|mera naam|my name)\s+.+?(?:है|hai|is)(?=\s|[।.!?,]|$)/i.test(message);
  const hasRememberRequest = /(?:याद रखो|याद रखना|याद रखिए|yaad rakho|yaad rakhna|remember(?: this| that)?)/i.test(message);
  const hasReminderRequest = /(?:remind|reminder|yaad\\s+dilana|yaad\\s+dila|याद\\s*दिलाना|याद\\s*दिलाओ|भूलना\\s*मत|bhoolna\\s+mat)/i.test(message)
    && /(?:\\b(?:aaj|today|kal|tomorrow|parso|day\\s+after\\s+tomorrow)\\b|आज|कल|परसों|\\b\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)\\b|\\d{1,2}(?::\\d{2})?\\s*बजे)/i.test(message);
  const compoundIdentityReminder = hasIdentity && hasRememberRequest && hasReminderRequest;
  // High-priority deterministic commands must bypass the generative AI fallback.
  const autonomousDirect = /^(?:khud\s+decide\s+karo(?:\s+aur\s+(?:test\s+shuru\s+karo|khud\s+start\s+karo))?|khud\s+decide\s+karna|khud\s+tay\s+karo|apne\s+aap\s+decide\s+karo(?:\s+aur\s+(?:test\s+shuru\s+karo|khud\s+start\s+karo))?|test\s+shuru\s+karo|khud\s+start\s+karo|start\s+the\s+test|decide\s+yourself\s+and\s+start)[.!?।\s]*$/i.test(message);
  const executeTaskDirect = /^(?:is\s+task\s+ko\s+khud\s+(?:execute|exicute)\s+karo|is\s+task\s+ko\s+(?:execute|exicute)\s+karo|task\s+ko\s+khud\s+(?:execute|exicute)\s+karo|execute\s+this\s+task|execute\s+the\s+task)[.!?।\s]*$/i.test(message);
  // Reminder phrases are deterministic and must work even when the generative AI is unavailable.
  const reminderDirect = (/(?:remind|reminder|yaad\s+dilana|yaad\s+dila|yaad\s+rakh(?:na|o|iye)?|याद\s*(?:दिलाना|दिलाओ|रखना|रखो|रखिए)|bhoolna\s+mat|मत\s*भूलना)/i.test(message) && /(?:\b(?:aaj|today|kal|tomorrow|parso|day\s+after\s+tomorrow)\b|आज|कल|परसों|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\d{1,2}(?::\d{2})?\s*बजे)/i.test(message));
  const reminderTitle = message.replace(/(?:remind\s+me\s+to|remind\s+me|reminder|yaad\s+dilana|yaad\s+dila|yaad\s+rakh(?:na|o|iye)?|याद\s*दिलाना|याद\s*दिलाओ|याद\s*रखना|याद\s*रखो|याद\s*रखिए|bhoolna\s+mat|मत\s*भूलना)/ig,"").replace(/(?:\b(?:aaj|today|kal|tomorrow|parso|day\s+after\s+tomorrow)\b|आज|कल|परसों)\s*(?:की|के|को)?\s*(?:शाम|सुबह|दोपहर|रात|evening|morning|afternoon|night)?\s*(?:\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\d{1,2}(?::\d{2})?\s*बजे)?/ig,"").replace(/[\s:,-]+/g," ").trim();
  const postponeDirect = /(?:postpone|reschedule|पोस्टपोन|स्थगित)/i.test(message) && /(?:कल|kal|tomorrow|के लिए|ke liye)/i.test(message);
  const postponeReference = message.replace(/(?:postpone|reschedule|पोस्टपोन|स्थगित)/ig,"").replace(/(?:कल|kal|tomorrow|के लिए|ke liye|कर दो|करो|do|karo|ko|को)/ig,"").replace(/[\s:,-]+/g," ").trim();
  const contextContinueDirect = /^(?:वो|उस|उस वाला|वही|वही वाला)\s+(?:काम|टास्क)(?:\s+को)?\s+(?:आगे|जारी)\s*(?:बढ़ाओ|बढ़ा(?:ओ|दो)|चलाओ|करो|कर दो|शुरू करो|जारी रखो)?[.!?।\s]*$/i.test(message) || /^(?:continue|carry on|keep going)\s+(?:that|the|same)\s+(?:task|work)[.!?\s]*$/i.test(message);
  const plan=contextContinueDirect ? {tool:"continue_context",args:{}} : executeTaskDirect ? {tool:"execute_task",args:{reference:""}} : autonomousDirect ? {tool:"jarvis_autonomous_step",args:{}} : postponeDirect ? {tool:"postpone_task",args:{reference:postponeReference,dueAt:extractDueAt("कल")}} : reminderDirect ? {tool:"create_task",args:{title:"Reminder: "+reminderTitle,priority:"high",dueAt:extractDueAt(message)}} : planTool(message);
  updatePersonalAlgorithm(message, plan.tool === "create_task" ? "planning" : plan.tool === "get_tasks" ? "tasks" : plan.tool === "complete_task" ? "task_complete" : plan.tool || detectedIntent);
  let toolResult=null; let verification=null; let responseText="";
  try{
    if(compoundIdentityReminder){
      const memoryContent=extractMemory(message);
      const reminderMatch=message.match(/(?:आज|कल|परसों|today|tomorrow|aaj|kal|parso)[\\s\\S]*$/i);
      const reminderMessage=reminderMatch ? reminderMatch[0] : message;
      const reminderTitle=reminderMessage
        .replace(/(?:remind\s+me\s+to|remind\s+me|reminder|yaad\s+dilana|yaad\s+dila|याद\s*दिलाना|याद\s*दिलाओ|bhoolna\s+mat|मत\s*भूलना)/ig,"")
        .replace(/^(?:आज|कल|परसों|today|tomorrow|aaj|kal|parso)\s*(?:की|के|को)?\s*(?:शाम|सुबह|दोपहर|रात|evening|morning|afternoon|night)?\s*(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\d{1,2}(?::\d{2})?\s*बजे)?\s*/i,"")
        .replace(/^[\s:,-]+/,"").trim();
            const saved=await executeTool("save_memory",{content:memoryContent,kind:"saved-memory"});
      const memoryVerification=verifyTool("save_memory",saved);
      const task=await executeTool("create_task",{title:"Reminder: "+reminderTitle,priority:"high",dueAt:extractDueAt(reminderMessage)});
      const taskVerification=verifyTool("create_task",task);
      updatePersonalAlgorithm(message,"memory");
      if(memoryVerification.verified && taskVerification.verified){
        responseText=`Yaad rakh liya: "${saved.memory.content}".\\n\\nReminder set kar diya: "${task.task.title}". Priority: ${task.task.priority}. Due: ${task.task.dueAt ? new Date(task.task.dueAt).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"}) : "not set"}.`;
      }else{
        responseText="Memory aur reminder dono ko verify karke complete karne mein dikkat hui.";
      }
    }
    // Deterministic goal execution must run before any AI/assistant-mode fallback.
    if(detectedIntent==="assistant_mode" && plan.tool!=="create_goal_and_plan" && plan.tool!=="continue_context"){
      const ai=await buildAssistantResponse(message,null,false);
      responseText=ai.success?ai.text:assistantModeFallback();
    }
    if(!responseText && !plan.tool && /^(mujhse|mujh se)\s+(normal|casual)\s+baat\s*(karo|karna|kijiye)?[.!?]*$/i.test(message)){responseText="Bilkul 😊 Aap aaram se baat kijiye. Main yahin hoon.";}
    if(!responseText && plan.tool){toolResult=await executeTool(plan.tool,plan.args);verification=verifyTool(plan.tool,toolResult);}
    if(!responseText){
    if(plan.tool==="create_goal_and_plan"&&verification?.verified){responseText="Goal samajh liya. Maine ise 3 concrete tasks mein tod diya aur pehla task khud start kar diya.\n\nGoal: " + toolResult.goal.title + "\n\nTasks:\n" + toolResult.tasks.map((t,i)=>(i+1)+". "+t.title+" — "+t.priority).join("\n") + "\n\nStarted: " + toolResult.firstTask.title + "\nStatus: " + toolResult.firstTask.status + "\nExecution verified."; }else if(plan.tool==="execute_task"&&verification?.verified){responseText="Samajh gaya. Maine active task ko khud execute karna shuru kar diya.\n\nTask: " + toolResult.task.title + "\nStatus: " + toolResult.task.status + "\nStep: " + toolResult.task.executionStep + "\nExecution verified.";}else if(plan.tool==="jarvis_autonomous_step"&&verification?.verified){responseText="Samajh gaya. Maine khud next action decide karke execution start kar diya.\n\nTarget: " + toolResult.target + "\nPehla step: " + toolResult.firstStep + "\nExecution verified.";
    }else if(plan.tool==="continue_context"&&verification?.verified){
      if(toolResult.type==="task") responseText="Samajh gaya. Pichhla active context pakad liya.\n\nAb isi kaam ko aage badhate hain: " + toolResult.target + "\nContext continuation verified.";
      else if(toolResult.type==="goal") responseText="Samajh gaya. Active goal ka context pakad liya.\n\nAb isi goal ko aage badhate hain: " + toolResult.target + "\nContext continuation verified.";
      else responseText="Samajh gaya. Active task/goal nahi mila, isliye recent conversation context available rakha hai. Pehle useful action ko context ke basis par continue kar sakte hain.";

    }else if(plan.tool==="save_memory"&&verification?.verified){responseText=`Theek hai, maine yaad rakh liya: "${toolResult.memory.content}"`;
    }else if(plan.tool==="recall_memory"){
      const found=toolResult?.memories||[]; const name=found.find(m=>/^User ka naam\s+.+$/i.test(m.content))?.content.match(/^User ka naam\s+(.+)$/i)?.[1]?.trim(); responseText=(/\b(mera naam|my name|what is my name|what's my name)\b/i.test(message)&&name)?`Aapka naam ${name}.`:found.length?found.map((m,i)=>`${i+1}. ${m.content}`).join("\n"):"Abhi mujhe matching memory nahi mili.";
    }else if(plan.tool==="web_search"){responseText=formatWebResponse(toolResult);}
    else if(plan.tool==="music_search"&&verification?.verified){responseText="Done — your music playlist is ready.";}
    else if(plan.tool==="create_task"&&verification?.verified){
      responseText="Task set kar diya: \"" + toolResult.task.title + "\". Priority: " + toolResult.task.priority + ". Execution verified.";
    }else if(plan.tool==="postpone_task"&&verification?.verified){
      const dueText=new Date(toolResult.task.dueAt).toLocaleString("en-IN",{timeZone:"Asia/Kolkata",day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"});
      responseText="Done. \"" + toolResult.task.title + "\" ko kal ke liye postpone kar diya. Due: " + dueText + ". Execution verified.";
    }else if(plan.tool==="complete_task"&&verification?.verified){
      responseText="Done. Task \"" + toolResult.task.title + "\" complete mark ho gaya. Execution verified.";
    }else if(plan.tool==="get_tasks"){
      const open=tasks.filter(t=>t.status!=="done");
      responseText=open.length?open.map((t,i)=>(i+1)+". "+t.title+" — "+t.priority).join("\\n"):"Abhi koi active task nahi hai.";
    }else if(plan.tool==="get_daily_plan"){
      const items=toolResult?.plan?.tasks||[];
      responseText=items.length?"Aaj ka execution order:\\n"+items.map((t,i)=>(i+1)+". "+t.title+" — "+t.priority).join("\\n"):"Abhi koi active task nahi hai.";
    }else if(plan.tool){responseText=JSON.stringify(toolResult);}
    else {const ai=await buildAssistantResponse(message,null,false);responseText=ai.success?ai.text:localBrain(message,ai.error);}
    }  }catch(error){responseText=localBrain(message,error?.message||"Unknown error");}
  addConversation("assistant",responseText);
  const proactive=jarvisContext();
  return res.json({success:true,response:responseText,tool:plan.tool||null,verification,data:{understanding:{intent:plan.tool==="create_task"?"planning":plan.tool==="complete_task"?"task_complete":plan.tool==="get_tasks"?"tasks":detectedIntent},execution:{tool:plan.tool||null,action:toolResult?.action||null,verified:Boolean(verification?.verified),verification:verification||null},jarvis:{nextAction:proactive.nextAction,context:proactive.context,highPriorityTasks:proactive.highPriorityTasks}}});
});

persistenceReady = initializePersistence();
persistenceReady.finally(() => {
  console.log("Amvexa state initialization complete.");
  setTimeout(() => runBrainCycle().catch(() => {}), 5000);
  setInterval(() => runBrainCycle().catch(() => {}), BRAIN_INTERVAL_MS);
});
app.listen(PORT,()=>console.log(`Amvexa AI ${VERSION} ${RELEASE} listening on ${PORT}`));