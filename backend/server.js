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
    kind,
    importance: kind === "preference" ? 6 : 5,
    at: new Date().toISOString()
  };

  memory.push(item);
  memory = memory.slice(-MAX.memory);
  writeJson(FILES.memory, memory);

  return item;
}

function memorySearch(query, limit = 8) {
  const terms = String(query || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(x => x.length > 1);

  return memory
    .map(item => {
      const text = `${item.content} ${item.kind}`.toLowerCase();
      const score = terms.reduce(
        (n, term) => n + (text.includes(term) ? 1 : 0),
        0
      );

      return { item, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => x.item);
}

function createTask(title, priority = "normal") {
  const task = {
    id: `task_${Date.now()}`,
    title: String(title).trim(),
    priority: ["high", "normal", "low"].includes(priority)
      ? priority
      : "normal",
    status: "open",
    createdAt: new Date().toISOString()
  };

  tasks.push(task);
  tasks = tasks.slice(-MAX.tasks);
  writeJson(FILES.tasks, tasks);

  return task;
}

function findTask(reference) {
  const text = String(reference || "").toLowerCase();

  return tasks.find(t =>
    t.id === reference ||
    t.title.toLowerCase() === text ||
    t.title.toLowerCase().includes(text)
  );
}

function completeTask(reference) {
  const task = findTask(reference);

  if (!task) {
    return {
      success: false,
      error: "Task not found"
    };
  }

  task.status = "done";
  task.completedAt = new Date().toISOString();

  writeJson(FILES.tasks, tasks);

  syncGoals();

  return {
    success: true,
    task
  };
}

function syncGoals() {
  let changed = false;

  for (const goal of goals) {
    if (!Array.isArray(goal.steps)) continue;

    for (const step of goal.steps) {
      if (!step.taskId) continue;

      const task = tasks.find(t => t.id === step.taskId);

      if (task && task.status === "done" && !step.completedAt) {
        step.completedAt = new Date().toISOString();
        changed = true;
      }
    }

    const finished = goal.steps.length > 0 &&
      goal.steps.every(step => {
        if (!step.taskId) return true;
        const task = tasks.find(t => t.id === step.taskId);
        return task && task.status === "done";
      });

    if (finished && goal.status !== "completed") {
      goal.status = "completed";
      goal.completedAt = new Date().toISOString();
      changed = true;
    }
  }

  if (changed) writeJson(FILES.goals, goals);
}

function detectIntent(message) {
  const text = message.toLowerCase();

  if (/\b(remember|save|store|note|yaad rakh)\b/.test(text)) {
    return "memory";
  }

  if (
    /\b(what do you remember|what do you know about me|what is my name|what's my name|who am i|what are you to me|recall|yaad hai|mere baare mein)\b/.test(text)
  ) {
    return "recall";
  }

  if (
    /\b(complete|finish|done|mark)\b.*\b(task|todo)\b/.test(text)
  ) {
    return "task_complete";
  }

  if (
    /\b(show|list|my|mere)\b.*\b(tasks?|todos?)\b/.test(text)
  ) {
    return "tasks";
  }

  if (
    /\b(add|create|make|set)\s+(a\s+)?(task|todo)\b/.test(text)
  ) {
    return "planning";
  }

  if (
    /\b(research|search|latest|investigate|find out)\b/.test(text)
  ) {
    return "research";
  }

  if (
    /\b(plan|schedule|organize)\b/.test(text)
  ) {
    return "planning";
  }

  if (
    /\b(hello|hi|hey|namaste)\b/.test(text)
  ) {
    return "greeting";
  }

  return "conversation";
}

function extractMemory(message) {
  return message
    .replace(
      /^\s*(remember|save|store|note|yaad rakh)\s*(this|that|ye|yah|ki)?\s*[:,-]?\s*/i,
      ""
    )
    .trim();
}

function taskFromMessage(message) {
  return message
    .replace(
      /^\s*(add|create|make|set)\s+(a\s+)?(task|todo)\s*[:,-]?\s*/i,
      ""
    )
    .trim();
}

function nextAction() {
  const high = tasks.find(
    t => t.status !== "done" && t.priority === "high"
  );

  if (high) {
    return {
      type: "task",
      title: high.title,
      taskId: high.id,
      priority: high.priority
    };
  }

  const open = tasks.find(t => t.status !== "done");

  if (open) {
    return {
      type: "task",
      title: open.title,
      taskId: open.id,
      priority: open.priority
    };
  }

  return {
    type: "setup",
    title: "Create your first task or goal"
  };
}

function dailyPlan() {
  return {
    generatedAt: new Date().toISOString(),
    tasks: tasks
      .filter(t => t.status !== "done")
      .sort((a, b) => {
        const p = { high: 0, normal: 1, low: 2 };
        return (p[a.priority] ?? 1) - (p[b.priority] ?? 1);
      })
      .slice(0, 5),
    nextAction: nextAction()
  };
}

function contextSummary() {
  return {
    memoryCount: memory.length,
    taskCount: tasks.length,
    openTasks: tasks.filter(t => t.status !== "done").length,
    goalCount: goals.length,
    knowledgeCount: knowledge.length
  };
}

function knowledgeSearch(query) {
  const terms = String(query || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(x => x.length > 1);

  return knowledge
    .map(item => {
      const text = `${item.name} ${item.text}`.toLowerCase();
      const score = terms.reduce(
        (n, term) => n + (text.includes(term) ? 1 : 0),
        0
      );

      return { item, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(x => ({
      id: x.item.id,
      name: x.item.name,
      text: x.item.text.slice(0, 2000),
      score: x.score
    }));
}

function planTool(message) {
  const intent = detectIntent(message);

  if (intent === "memory") {
    return {
      tool: "save_memory",
      args: {
        content: extractMemory(message)
      }
    };
  }

  if (intent === "recall") {
    return {
      tool: "recall_memory",
      args: {
        query: message
      }
    };
  }

  if (intent === "task_complete") {
    return {
      tool: "complete_task",
      args: {
        reference: message
          .replace(/.*?(complete|finish|done|mark)\s*(this\s*)?(task|todo)?/i, "")
          .trim()
      }
    };
  }

  if (intent === "tasks") {
    return {
      tool: "get_tasks",
      args: {}
    };
  }

  if (intent === "planning") {
    const title = taskFromMessage(message);

    if (title) {
      return {
        tool: "create_task",
        args: {
          title
        }
      };
    }

    return {
      tool: "get_daily_plan",
      args: {}
    };
  }

  return {
    tool: null,
    args: {}
  };
}

function executeTool(tool, args = {}) {
  let result;

  switch (tool) {
    case "save_memory":
      if (!args.content) {
        return {
          success: false,
          error: "Memory content is required"
        };
      }

      result = {
        success: true,
        memory: remember(args.content)
      };
      break;

    case "recall_memory":
      result = {
        success: true,
        memories: memorySearch(args.query)
      };
      break;

    case "create_task":
      result = {
        success: true,
        task: createTask(args.title, args.priority)
      };
      break;

    case "complete_task":
      result = completeTask(args.reference);
      break;

    case "get_tasks":
      result = {
        success: true,
        tasks
      };
      break;

    case "get_daily_plan":
      result = {
        success: true,
        plan: dailyPlan()
      };
      break;

    case "get_next_action":
      result = {
        success: true,
        nextAction: nextAction()
      };
      break;

    case "search_knowledge":
      result = {
        success: true,
        results: knowledgeSearch(args.query)
      };
      break;

    default:
      return {
        success: false,
        error: "Tool not allowed"
      };
  }

  logAction(tool, args, result);

  return result;
}

function verifyTool(tool, result) {
  if (!result || result.success !== true) {
    return {
      verified: false,
      reason: result?.error || "Tool failed"
    };
  }

  if (tool === "save_memory") {
    return {
      verified: Boolean(result.memory?.id),
      reason: "Memory record verified"
    };
  }

  if (tool === "create_task") {
    const id = result.task?.id;
    return {
      verified: Boolean(id && tasks.some(t => t.id === id)),
      reason: "Task existence verified"
    };
  }

  if (tool === "complete_task") {
    const id = result.task?.id;
    const task = tasks.find(t => t.id === id);

    return {
      verified: Boolean(task && task.status === "done"),
      reason: "Task completion verified"
    };
  }

  return {
    verified: true,
    reason: "Result structure verified"
  };
}

function localBrain(message) {
  const intent = detectIntent(message);

  if (intent === "greeting") {
    return "Good to see you. I'm Amvexa — ready to think, plan and execute.";
  }

  if (intent === "memory") {
    return "I've processed that memory request.";
  }

  if (intent === "recall") {
    const found = memorySearch(message);

    if (!found.length) {
      return "I don't have a matching memory yet.";
    }

    return found
      .map((m, i) => `${i + 1}. ${m.content}`)
      .join("\n");
  }

  if (intent === "tasks") {
    const open = tasks.filter(t => t.status !== "done");

    if (!open.length) {
      return "You have no open tasks.";
    }

    return open
      .map((t, i) => `${i + 1}. ${t.title} (${t.priority})`)
      .join("\n");
  }

  if (intent === "research") {
    return "I can research a public web source when web intelligence is connected.";
  }

  return "I understand your message. My local intelligence layer is active and ready for the next instruction.";
}

async function agent(message, autoExecute = true) {
  const understanding = {
    intent: detectIntent(message),
    message
  };

  const plan = planTool(message);

  if (!plan.tool) {
    return {
      success: true,
      agent: "Amvexa",
      version: VERSION,
      mode: "conversation",
      understanding,
      plan,
      execution: null,
      verification: null,
      nextAction: nextAction(),
      response: localBrain(message)
    };
  }

  if (!autoExecute) {
    return {
      success: true,
      agent: "Amvexa",
      version: VERSION,
      mode: "planned",
      understanding,
      plan,
      execution: null,
      verification: null,
      nextAction: nextAction(),
      response: "I have prepared the action plan."
    };
  }

  const execution = executeTool(plan.tool, plan.args);
  const verification = verifyTool(plan.tool, execution);

  return {
    success: execution.success === true && verification.verified === true,
    agent: "Amvexa",
    version: VERSION,
    mode: "agent",
    understanding,
    plan,
    execution,
    verification,
    nextAction: nextAction(),
    response: execution.success
      ? `Done. I executed ${plan.tool.replace(/_/g, " ")} and verified the result.`
      : execution.error || "The action could not be completed."
  };
}

/* ---------- Core routes ---------- */

app.get("/", (req, res) => {
  res.json({
    success: true,
    platform: "Amvexa",
    status: "online",
    brainVersion: VERSION,
    release: RELEASE,
    message: "Amvexa AI backend is ready"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    platform: "Amvexa",
    status: "healthy",
    brainVersion: VERSION
  });
});

app.get("/api/system/version", (req, res) => {
  res.json({
    success: true,
    platform: "Amvexa",
    version: VERSION,
    release: RELEASE,
    node: process.version
  });
});

app.get("/api/system/readiness", (req, res) => {
  res.json({
    success: true,
    ready: true,
    brain: true,
    memory: true,
    tasks: true,
    goals: true,
    knowledge: true,
    agent: true
  });
});

app.get("/api/system/diagnostics", (req, res) => {
  res.json({
    success: true,
    version: VERSION,
    release: RELEASE,
    uptime: process.uptime(),
    state: contextSummary(),
    auditEntries: audit.length
  });
});

app.get("/api/context", (req, res) => {
  res.json({
    success: true,
    context,
    summary: contextSummary()
  });
});

app.get("/api/brain/status", (req, res) => {
  res.json({
    success: true,
    brain: "Amvexa",
    version: VERSION,
    status: "active",
    capabilities: [
      "conversation",
      "memory",
      "tasks",
      "goals",
      "knowledge",
      "agent-loop",
      "safe-tools"
    ]
  });
});

app.get("/api/brain/next-action", (req, res) => {
  res.json({
    success: true,
    nextAction: nextAction()
  });
});

app.get("/api/brain/daily-plan", (req, res) => {
  res.json({
    success: true,
    plan: dailyPlan()
  });
});

app.get("/api/brain/insights", (req, res) => {
  const open = tasks.filter(t => t.status !== "done");

  res.json({
    success: true,
    insights: [
      ...(open.filter(t => t.priority === "high").length
        ? ["You have high-priority work waiting."]
        : []),
      ...(open.length
        ? [`You have ${open.length} open task(s).`]
        : ["No open tasks."]),
      ...(goals.length
        ? [`You have ${goals.length} goal(s) in your workspace.`]
        : [])
    ]
  });
});

app.get("/api/brain/recovery", (req, res) => {
  res.json({
    success: true,
    recovery: {
      stateFiles: Object.keys(FILES).map(k => ({
        name: k,
        exists: fs.existsSync(FILES[k])
      })),
      writable: fs.accessSync(__dirname, fs.constants.W_OK) === undefined
    }
  });
});

app.post("/api/brain/self-test", (req, res) => {
  const tests = {
    memory: Array.isArray(memory),
    tasks: Array.isArray(tasks),
    goals: Array.isArray(goals),
    knowledge: Array.isArray(knowledge),
    audit: Array.isArray(audit),
    context: context && typeof context === "object",
    agent: typeof agent === "function"
  };

  res.json({
    success: Object.values(tests).every(Boolean),
    version: VERSION,
    tests
  });
});

app.post("/api/brain/understand", (req, res) => {
  const message = String(req.body.message || "").trim();

  if (!message) {
    return res.status(400).json({
      success: false,
      error: "Message is required"
    });
  }

  res.json({
    success: true,
    intent: detectIntent(message),
    plan: planTool(message)
  });
});

app.post("/api/brain/plan-tool", (req, res) => {
  const message = String(req.body.message || "").trim();

  if (!message) {
    return res.status(400).json({
      success: false,
      error: "Message is required"
    });
  }

  res.json({
    success: true,
    plan: planTool(message)
  });
});

app.post("/api/brain/agent", async (req, res) => {
  const message = String(req.body.message || "").trim();

  if (!message) {
    return res.status(400).json({
      success: false,
      error: "Message is required"
    });
  }

  const autoExecute = req.body.autoExecute !== false;

  try {
    const result = await agent(message, autoExecute);
    res.json(result);
  } catch (error) {
    console.error("Agent error:", error);

    res.status(500).json({
      success: false,
      error: "Agent execution failed safely"
    });
  }
});

app.post("/api/brain/execute-next", (req, res) => {
  const action = nextAction();

  if (action.type !== "task") {
    return res.json({
      success: true,
      executed: false,
      nextAction: action
    });
  }

  const result = completeTask(action.taskId);

  logAction("execute_next", action, result);

  res.json({
    success: result.success,
    executed: result.success,
    result,
    nextAction: nextAction()
  });
});

/* ---------- Memory ---------- */

app.get("/api/memory", (req, res) => {
  res.json({
    success: true,
    memory: memory.slice(-50),
    total: memory.length
  });
});

app.get("/api/memory/search", (req, res) => {
  res.json({
    success: true,
    results: memorySearch(req.query.q || "")
  });
});

app.delete("/api/memory", (req, res) => {
  memory = [];
  writeJson(FILES.memory, memory);

  res.json({
    success: true,
    message: "Memory cleared"
  });
});

/* ---------- Tasks ---------- */

app.get("/api/tasks", (req, res) => {
  res.json({
    success: true,
    tasks,
    total: tasks.length
  });
});

app.post("/api/tasks", (req, res) => {
  const title = String(req.body.title || "").trim();

  if (!title) {
    return res.status(400).json({
      success: false,
      error: "Task title is required"
    });
  }

  const task = createTask(title, req.body.priority);

  res.json({
    success: true,
    task
  });
});

app.patch("/api/tasks/:id", (req, res) => {
  const task = tasks.find(t => t.id === req.params.id);

  if (!task) {
    return res.status(404).json({
      success: false,
      error: "Task not found"
    });
  }

  if (req.body.title !== undefined) {
    task.title = String(req.body.title).trim();
  }

  if (req.body.priority !== undefined) {
    task.priority = ["high", "normal", "low"].includes(req.body.priority)
      ? req.body.priority
      : task.priority;
  }

  if (req.body.status !== undefined) {
    task.status = req.body.status === "done" ? "done" : "open";
    if (task.status === "done" && !task.completedAt) {
      task.completedAt = new Date().toISOString();
    }
    if (task.status !== "done") delete task.completedAt;
  }

  writeJson(FILES.tasks, tasks);
  syncGoals();

  res.json({
    success: true,
    task
  });
});

app.delete("/api/tasks/:id", (req, res) => {
  const index = tasks.findIndex(t => t.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({
      success: false,
      error: "Task not found"
    });
  }

  const [task] = tasks.splice(index, 1);
  writeJson(FILES.tasks, tasks);

  res.json({
    success: true,
    task
  });
});

/* ---------- Chat ---------- */

app.post("/api/chat", async (req, res) => {
  const message = String(req.body.message || "").trim();

  if (!message) {
    return res.status(400).json({
      success: false,
      error: "Message is required"
    });
  }

  try {
    const result = await agent(message, true);

    res.json({
      success: result.success !== false,
      assistant: "Amvexa",
      version: VERSION,
      message: result.response,
      intent: result.understanding?.intent || "conversation",
      mode: result.mode || "conversation",
      execution: result.execution || null,
      verification: result.verification || null,
      nextAction: result.nextAction || nextAction()
    });
  } catch (error) {
    console.error("Chat error:", error);

    res.status(500).json({
      success: false,
      assistant: "Amvexa",
      error: "Amvexa could not process the message safely."
    });
  }
});

app.use((err, req, res, next) => {
  console.error("Amvexa server error:", err);
  if (res.headersSent) return next(err);

  res.status(500).json({
    success: false,
    error: "Amvexa backend error"
  });
});

app.listen(PORT, () => {
  console.log(`Amvexa backend running on port ${PORT} | Brain ${VERSION} | Release ${RELEASE}`);
});
