const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;
const ROOT = path.join(__dirname, "..");
const VERSION = "4.0";
const RELEASE = "1.1.0";

const FILES = {
  memory: path.join(__dirname, "memory.json"),
  tasks: path.join(__dirname, "tasks.json"),
  goals: path.join(__dirname, "goals.json"),
  context: path.join(__dirname, "context.json"),
  audit: path.join(__dirname, "audit.json"),
  knowledge: path.join(__dirname, "knowledge.json"),
  conversation: path.join(__dirname, "conversation.json")
};

const MAX = {
  memory: 100,
  tasks: 100,
  goals: 50,
  audit: 200,
  knowledge: 100,
  conversation: 30
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
let conversation = Array.isArray(readJson(FILES.conversation, [])) ? readJson(FILES.conversation, []) : [];

function saveAll() {
  writeJson(FILES.memory, memory.slice(-MAX.memory));
  writeJson(FILES.tasks, tasks.slice(-MAX.tasks));
  writeJson(FILES.goals, goals.slice(-MAX.goals));
  writeJson(FILES.audit, audit.slice(-MAX.audit));
  writeJson(FILES.knowledge, knowledge.slice(-MAX.knowledge));
  writeJson(FILES.context, context);
  writeJson(FILES.conversation, conversation.slice(-MAX.conversation));
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

  goals = goals.map(goal => {
    if (!goal.taskIds) return goal;

    const done = goal.taskIds.filter(id => {
      const task = tasks.find(t => t.id === id);
      return task && task.status === "done";
    }).length;

    const status = done === goal.taskIds.length ? "done" : "open";

    if (goal.status !== status) {
      changed = true;
      return { ...goal, status };
    }

    return goal;
  });

  if (changed) writeJson(FILES.goals, goals);
}

function detectIntent(message) {
  const text = message.toLowerCase().trim();

  if (
    /\b(remember|save|store|note|yaad rakh)\b/.test(text) ||
    /\b(hamesha|always)\b.*\b(hindi|हिंदी)\b/.test(text) ||
    /\b(hindi|हिंदी)\b.*\b(hamesha|always)\b/.test(text)
  ) {
    return "memory";
  }

  if (
    /\b(what do you remember|what do you know about me|what is my name|what's my name|who am i|what are you to me|recall|yaad hai|mere baare mein)\b/.test(text)
  ) {
    return "recall";
  }

  if (/\b(complete|finish|done|mark)\b.*\b(task|todo)\b/.test(text)) {
    return "task_complete";
  }

  if (
    /\b(show|list|my|mere)\b.*\b(tasks?|todos?)\b/.test(text) ||
    /(mere|aaj|aj|today|jaruri|zaroori|important).*(kaam|task|todo)/.test(text) ||
    /(kaam|tasks?|todos?).*(batao|dikhao|dikhaiye|bataiye|show|list)/.test(text)
  ) {
    return "tasks";
  }

  if (/\b(add|create|creat|make|set|new)\s+(a\s+)?(task|tast|todo)\b/.test(text)) {
    return "planning";
  }

  if (
    /\b(play|listen|bajao|music|song|songs|gaana|gana|romantic|playlist|youtube)\b/.test(text) || ( /\b(sunao|sunaao)\b/.test(text) && /\b(gaana|gana|song|songs|music|romantic|playlist)\b/.test(text) )
  ) {
    return "music";
  }

  if (/\b(research|search|latest|investigate|find out)\b/.test(text)) {
    return "research";
  }

  if (
    /\b(plan|schedule|organize)\b/.test(text) ||
    /(aaj|aj|today).*(kaam|work|tasks?|todo|plan)/.test(text) ||
    /(daily|din).*(plan|kaam|work)/.test(text)
  ) {
    return "planning";
  }

  if (/\b(hello|hi|hey|namaste)\b/.test(text)) {
    return "greeting";
  }

  if (
    /\b(what|why|how|when|where|who|which|can you|do you|are you|tum|aap|kya|kyun|kaise|kab|kahan|kaun|hai|ho)\b/.test(text)
  ) {
    return "question";
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
      /^\s*(add|create|creat|make|set|new)\s+(a\s+)?(task|tast|todo)\s*[:,-]?\s*/i,
      ""
    )
    .trim();
}

function nextAction() {
  const high = tasks.find(t => t.status !== "done" && t.priority === "high");

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

function addConversation(role, content) {
  conversation.push({ id: `turn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, role, content: String(content || "").slice(0, 5000), at: new Date().toISOString() });
  conversation = conversation.slice(-MAX.conversation);
  writeJson(FILES.conversation, conversation);
}

function conversationContext(limit = 12) {
  return conversation.slice(-limit).map(turn => ({ role: turn.role === "assistant" ? "model" : "user", parts: [{ text: turn.content }] }));
}

async function generateAIResponse(message, extraContext = "") {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { success: false, error: "AI provider is not configured" };
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const system = [
    "You are Amvexa, a personal AI assistant for one user.",
    "You are not a command parser. Hold a natural, continuous conversation.",\n    "You are Amvexa, the user's own personal assistant software. Never claim that Amazon, Google, OpenAI, or another company created you unless the user explicitly asks about the underlying model/provider.",
    "Understand Hindi, Hinglish and English and normally reply in natural Hindi/Hinglish unless the user asks otherwise.",
    "Be concise but thoughtful. Do not repeat generic greetings or ask what you can do after every message.",
    "Use recent conversation context and relevant remembered facts.",
    "Never claim an action happened unless the execution result confirms it.",
    "When current information is needed, use supplied web research rather than inventing facts.",
    "You may suggest the next useful step when appropriate, without being pushy.", extraContext
  ].filter(Boolean).join("\n");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system_instruction: { parts: [{ text: system }] }, contents: [...conversationContext(), { role: "user", parts: [{ text: message }] }], generationConfig: { temperature: 0.7, maxOutputTokens: 700 } }), signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { success: false, error: data?.error?.message || "AI provider request failed" };
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim();
    return text ? { success: true, text } : { success: false, error: "AI provider returned no response" };
  } catch (error) {
    return { success: false, error: error?.name === "AbortError" ? "AI provider timed out" : "AI provider unavailable" };
  } finally { clearTimeout(timeout); }
}

async function buildAssistantResponse(message, toolResult) {
  const memoryContext = memorySearch(message, 5).map(m => m.content).join("\n");
  const webContext = toolResult?.success && toolResult?.results?.length ? toolResult.results.slice(0, 6).map(r => `${r.title}\n${r.content}\n${r.url}`).join("\n\n") : "";
  const extra = [memoryContext ? `Relevant remembered facts:\n${memoryContext}` : "", webContext ? `Fresh web research:\n${webContext}` : ""].filter(Boolean).join("\n\n");
  return generateAIResponse(message, extra);
}

async function webSearch(query) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return { success: false, error: "Web intelligence is not configured", results: [] };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query: String(query || "").trim() + (
          /\\b(news|khabar|today|aaj|latest|current|recent)\\b/i.test(String(query || ""))
            ? " Give the answer in Hindi. For each story, include the source name and publication date when available."
            : " Answer in Hindi."
        ),
        search_depth: "advanced",
        max_results: 6,
        include_answer: true,
        include_raw_content: false
      }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { success: false, error: data?.detail || data?.message || "Web search failed", results: [] };
    return {
      success: true,
      answer: data?.answer || "",
      results: Array.isArray(data?.results) ? data.results.map(item => ({
        title: item.title || "",
        url: item.url || "",
        content: String(item.content || "").slice(0, 2500),
        score: item.score,
        published_date: item.published_date || item.publishedAt || item.date || ""
      })) : []
    };
  } catch (error) {
    return { success: false, error: error?.name === "AbortError" ? "Web search timed out" : "Web search unavailable", results: [] };
  } finally {
    clearTimeout(timeout);
  }
}

function formatWebResponse(result) {
  if (!result?.success) {
    return result?.error === "Web intelligence is not configured"
      ? "Web intelligence abhi connected nahi hai. TAVILY_API_KEY configure hone ke baad main live internet research kar sakta hoon."
      : "Web research abhi complete nahi ho payi.";
  }
  const lines = [];
  if (result.answer) lines.push(result.answer.trim());
  if (result.results?.length) {
    lines.push("", "Sources:");
    result.results.forEach((item, index) => {
      lines.push((index + 1) + ". " + (item.title || item.url));
      if (item.published_date) lines.push("   Date: " + item.published_date);
      if (item.url) lines.push("   Source: " + item.url);
    });
  }
  return lines.join("\n");
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
    const content = /\b(hindi|हिंदी)\b/i.test(message)
      ? "Mujhe hamesha Hindi mein jawab dena hai."
      : extractMemory(message);
    return { tool: "save_memory", args: { content, kind: /\b(hindi|हिंदी)\b/i.test(message) ? "preference" : "saved-memory" } };
  }

  if (intent === "recall") {
    return { tool: "recall_memory", args: { query: message } };
  }

  if (intent === "task_complete") {
    return { tool: "complete_task", args: { reference: message } };
  }

  if (intent === "music") {
    return {
      tool: "music_search",
      args: { query: message }
    };
  }

  if (intent === "tasks") {
    return { tool: "get_tasks", args: {} };
  }

  if (intent === "planning") {
    return { tool: "get_daily_plan", args: {} };
  }

  if (
    intent === "research" ||
    intent === "question" ||
    /\b(news|khabar|today|aaj|latest|current|recent|source|sources|date|tarikh)\b/i.test(message)
  ) {
    return { tool: "web_search", args: { query: message } };
  }

  return { tool: null, args: {} };
}

async function executeTool(tool, args = {}) {
  let result;

  switch (tool) {
    case "save_memory":
      result = { success: true, memory: remember(args.content, args.kind || "saved-memory") };
      break;

    case "recall_memory":
      result = { success: true, memories: memorySearch(args.query) };
      break;

    case "create_task":
      result = { success: true, task: createTask(args.title, args.priority) };
      break;

    case "complete_task":
      result = completeTask(args.reference);
      break;

    case "music_search": {
      const query = String(args.query || "").trim() || "romantic songs";
      const playlistUrl = "https://youtube.com/playlist?list=PL-ER7jNwYADztaCaTFnTMGBoGWaIUQ0K4&si=6o-Ln9w2WHvlUKgt";
      result = {
        success: true,
        action: {
          type: "music",
          query,
          url: playlistUrl,
          playlist: true
        }
      };
      break;
    }

    case "get_tasks":
      result = { success: true, tasks };
      break;

    case "get_daily_plan":
      result = { success: true, plan: dailyPlan() };
      break;

    case "get_next_action":
      result = { success: true, nextAction: nextAction() };
      break;

    case "search_knowledge":
      result = { success: true, results: knowledgeSearch(args.query) };
      break;

    case "web_search":
      result = await webSearch(args.query);
      break;

    default:
      return { success: false, error: "Tool not allowed" };
  }

  logAction(tool, args, result);
  return result;
}

function verifyTool(tool, result) {
  if (!result || result.success !== true) {
    return { verified: false, reason: result?.error || "Tool failed" };
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

  return { verified: true, reason: "Result structure verified" };
}

function localBrain(message) {
  const text = String(message || "").trim();
  const lower = text.toLowerCase();
  const intent = detectIntent(text);

  if (/hindi.*(nahi|nahin).*aati|hindi.*samajh|hindi.*aati.*kya/.test(lower)) {
    return "Aati hai. Aap Hindi mein bilkul baat kijiye.";
  }

  if (intent === "greeting") {
    return "Namaste! Main Amvexa hoon. Aap batayiye, main kya karun?";
  }

  if (intent === "memory") {
    const content = extractMemory(text);
    return content
      ? `Theek hai, maine yaad rakh liya: "${content}"`
      : "Bilkul. Jo baat aap chahte hain ki main yaad rakhun, woh bataiye.";
  }

  if (intent === "recall") {
    const found = memorySearch(text);
    return found.length
      ? found.map((m, i) => `${i + 1}. ${m.content}`).join("\n")
      : "Abhi mujhe matching memory nahi mili.";
  }

  if (intent === "tasks") {
    const open = tasks.filter(t => t.status !== "done");
    return open.length
      ? open.map((t, i) => `${i + 1}. ${t.title} (${t.priority})`).join("\n")
      : "Aaj ke liye koi open task nahi hai.";
  }

  if (intent === "planning") {
    const plan = dailyPlan();
    if (!plan.tasks.length) {
      return "Aaj ke liye koi open task nahi hai. Aap chahein to main aapke liye daily plan bana sakta hoon.";
    }
    return [
      "Aaj ka plan:",
      ...plan.tasks.map((t, i) => `${i + 1}. ${t.title} — ${t.priority}`),
      `Next action: ${plan.nextAction.title}`
    ].join("\n");
  }

  if (intent === "research") {
    const results = knowledgeSearch(text);
    return results.length
      ? results.map((r, i) => `${i + 1}. ${r.name}: ${r.text}`).join("\n")
      : "Main is topic ko research kar sakta hoon, lekin abhi web intelligence connected nahi hai.";
  }

  if (intent === "question") {
    if (/who are you|tum kaun|aap kaun|what are you|tum kya ho|aap kya ho/.test(lower)) {
      return "Main Amvexa hoon — aapka personal AI assistant. Main planning, tasks, memory, research aur everyday questions mein help karta hoon.";
    }

    if (/how are you|kaise ho|kaisi ho/.test(lower)) {
      return "Main ready hoon. Aap jo kaam ya sawaal denge, usi ke hisaab se help karunga.";
    }

    if (/help|madad|kya kar sakte|what can you do|kya kya/.test(lower)) {
      return "Main aapke tasks manage kar sakta hoon, baatein yaad rakh sakta hoon, daily planning mein help kar sakta hoon aur available knowledge par research kar sakta hoon.";
    }

    if (/time|samay|kitne baje/.test(lower)) {
      return `Abhi server time ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} hai.`;
    }

    return `Aapne poocha: "${text}". Main is sawaal ko samajh raha hoon. Iska accurate answer dene ke liye mujhe relevant knowledge ya web intelligence chahiye.`;
  }

  return "Samajh gaya. Aap apna kaam ya sawaal batayiye, main uske hisaab se help karunga.";
}

async function agent(message, autoExecute = true) {
  const understanding = {
    intent: detectIntent(message),
    message
  };

  const plan = planTool(message);

  if (!plan.tool) {
    const ai = await buildAssistantResponse(message, null);
    const response = ai.success ? ai.text : localBrain(message);
    addConversation("user", message);
    addConversation("assistant", response);
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
      response
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

  const execution = await executeTool(plan.tool, plan.args);
  const verification = verifyTool(plan.tool, execution);

  let response = localBrain(message);

  if (plan.tool === "music_search") {
    response = "Bilkul 🎵 Aapki personal music playlist khol raha hoon.";
  }

  if (plan.tool === "get_tasks") {
    const open = execution.tasks.filter(t => t.status !== "done");
    response = open.length
      ? open.map((t, i) => `${i + 1}. ${t.title} (${t.priority})`).join("\n")
      : "Aaj ke liye koi open task nahi hai.";
  }

  if (plan.tool === "get_daily_plan") {
    const planData = execution.plan;
    response = planData.tasks.length
      ? ["Aaj ka plan:", ...planData.tasks.map((t, i) => `${i + 1}. ${t.title} — ${t.priority}`), `Next action: ${planData.nextAction.title}`].join("\n")
      : "Aaj ke liye koi open task nahi hai. Aap chahein to main aapke liye daily plan bana sakta hoon.";
  }

  if (plan.tool === "save_memory") {
    response = `Theek hai, maine yaad rakh liya: "${execution.memory.content}"`;
  }

  if (plan.tool === "recall_memory") {
    response = execution.memories?.length
      ? execution.memories.map((m, i) => `${i + 1}. ${m.content}`).join("\n")
      : "Abhi mujhe matching memory nahi mili.";
  }

  if (plan.tool === "web_search") {
    const ai = await buildAssistantResponse(message, execution);
    response = ai.success ? ai.text : formatWebResponse(execution);
  } else if (plan.tool !== "music_search" && plan.tool !== "save_memory" && plan.tool !== "recall_memory" && plan.tool !== "get_tasks" && plan.tool !== "get_daily_plan") {
    const ai = await buildAssistantResponse(message, execution);
    if (ai.success) response = ai.text;
  }

  addConversation("user", message);
  addConversation("assistant", response);

  return {
    success: execution.success === true && verification.verified === true,
    agent: "Amvexa",
    version: VERSION,
    mode: "executed",
    understanding,
    plan,
    execution,
    verification,
    nextAction: nextAction(),
    response
  };
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "amvexa-ai",
    version: VERSION,
    release: RELEASE
  });
});

app.post("/api/chat", async (req, res) => {
  try {
    const message = String(req.body?.message || "").trim();

    if (!message) {
      return res.status(400).json({
        success: false,
        error: "Message is required"
      });
    }

    const result = await agent(message, true);

    res.json({
      success: true,
      message: result.response,
      data: result
    });
  } catch (error) {
    console.error("Chat error:", error);

    res.status(500).json({
      success: false,
      error: "Unable to process message"
    });
  }
});

app.get("/api/conversation", (req, res) => {
  res.json({ success: true, conversation: conversation.slice(-MAX.conversation) });
});

app.get("/api/proactive", (req, res) => {
  const openTasks = tasks.filter(t => t.status !== "done");
  const hour = new Date().getHours();
  let message = "";
  if (openTasks.length) {
    const first = openTasks.find(t => t.priority === "high") || openTasks[0];
    message = hour < 12 ? `Good morning. Aaj ka important kaam: ${first.title}` : `Ek important kaam abhi pending hai: ${first.title}`;
  } else if (hour < 12) message = "Good morning. Main online hoon. Aaj jo important hai, use saath mein organize kar sakte hain.";
  res.json({ success: true, shouldSpeak: Boolean(message), message, at: new Date().toISOString() });
});

app.get("/api/context", (req, res) => {
  res.json({
    success: true,
    context: contextSummary()
  });
});

app.get("/api/memory", (req, res) => {
  res.json({
    success: true,
    memory
  });
});

app.get("/api/tasks", (req, res) => {
  res.json({
    success: true,
    tasks
  });
});

app.get("/api/goals", (req, res) => {
  res.json({
    success: true,
    goals
  });
});

app.get("/api/audit", (req, res) => {
  res.json({
    success: true,
    audit
  });
});

app.listen(PORT, () => {
  console.log(`Amvexa backend listening on port ${PORT}`);
  console.log(`Version: ${VERSION}`);
  console.log(`Release: ${RELEASE}`);
});
