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

let memory = Array.isArray(readJson(FILES.memory, [])) ? readJson(FILES.memory, []) : [];
let tasks = Array.isArray(readJson(FILES.tasks, [])) ? readJson(FILES.tasks, []) : [];
let goals = Array.isArray(readJson(FILES.goals, [])) ? readJson(FILES.goals, []) : [];
let audit = Array.isArray(readJson(FILES.audit, [])) ? readJson(FILES.audit, []) : [];
let knowledge = Array.isArray(readJson(FILES.knowledge, [])) ? readJson(FILES.knowledge, []) : [];
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

function createTask(title, priority = "normal") {
  const task = { id: `task_${Date.now()}`, title: String(title).trim(), priority: ["high", "normal", "low"].includes(priority) ? priority : "normal", status: "open", createdAt: new Date().toISOString() };
  tasks.push(task); tasks = tasks.slice(-MAX.tasks); writeJson(FILES.tasks, tasks); return task;
}

function findTask(reference) {
  const text = String(reference || "").toLowerCase();
  return tasks.find(t => t.id === reference || t.title.toLowerCase() === text || t.title.toLowerCase().includes(text));
}

function completeTask(reference) {
  const task = findTask(reference);
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
  if (/\b(remember|save|store|note|yaad rakh(?:o|na)?)\b/.test(text) || /\bmera naam\s+.+?(?:hai|yaad rakh)/i.test(text) || /\b(my name is)\b/i.test(text)) return "memory";
  if (/\b(what do you remember|what do you know about me|what is my name|what's my name|who am i|recall|yaad hai|mere baare mein|mere baare me)\b/.test(text) || /^\s*(mera naam|my name)\s+(kya|what)\b/i.test(text)) return "recall";
  if (/\b(complete|finish|done|mark)\b.*\b(task|todo)\b/.test(text)) return "task_complete";
  if (/\b(show|list|my|mere)\b.*\b(tasks?|todos?)\b/.test(text) || /(mere|aaj|aj|today|jaruri|zaroori|important).*(kaam|task|todo)/.test(text) || /(kaam|tasks?|todos?).*(batao|dikhao|dikhaiye|bataiye|show|list)/.test(text)) return "tasks";
  if (/\b(?:ek\s+)?(?:task|tast|todo)\s+(?:add|create|bana)\s+(?:karo|karna|do)\b/i.test(text) || /\b(?:add|create|creat|make|set|new)\s+(?:a\s+)?(?:task|tast|todo)\b/i.test(text) || /^\s*(?:kal|tomorrow|aaj|today)\b.+\b(?:karna|karne|complete|finish|niptana|niptane)\b/i.test(text)) return "planning";
  if (/\b(play|listen|bajao|music|song|songs|gaana|gana|romantic|playlist|youtube)\b/.test(text)) return "music";
  if (/\b(research|search|latest|investigate|find out)\b/.test(text)) return "research";
  if (/\b(plan|schedule|organize)\b/.test(text) || /(aaj|aj|today).*(kaam|work|tasks?|todo|plan)/.test(text) || /(daily|din).*(plan|kaam|work)/.test(text)) return "planning";
  if (/\b(hello|hi|hey|namaste)\b/.test(text)) return "greeting";
  if (/\b(what|why|how|when|where|who|which|can you|do you|are you|tum|aap|kya|kyun|kaise|kab|kahan|kaun|hai|ho)\b/.test(text)) return "question";
  return "conversation";
}

function extractMemory(message) {
  const identity = String(message || "").match(/^\s*(?:mera naam|my name)\s+(.+?)(?:\s+(?:hai|is|h)\b|\s+(?:yaad rakh|yaad rakho|yaad rakhna)\b|$)/i);
  if (identity) return "User ka naam " + identity[1].trim();
  return message.replace(/^\s*(remember|save|store|note|yaad rakh(?:o|na)?)\s*(this|that|ye|yah|ki)?\s*[:,-]?\s*/i, "").trim();
}

function taskFromMessage(message) {
  let title = String(message || "").trim();
  title = title.replace(/^\s*[“"']?\s*(?:ek\s+)?(?:task|tast|todo)\s+(?:add|create|bana)\s+(?:karo|karna|do)\b\s*[,;:\-]?\s*/i, "");
  title = title.replace(/^\s*[“"']?\s*(?:add|create|creat|make|set|new)\s+(?:a\s+)?(?:task|tast|todo)\b\s*(?:karo|karna|do)?\s*[,;:\-]?\s*/i, "");
  title = title.replace(/[”"']\s*$/, "").trim();
  return title;
}

function nextAction() { const high = tasks.find(t => t.status !== "done" && t.priority === "high"); if (high) return { type: "task", title: high.title, taskId: high.id, priority: high.priority }; const open = tasks.find(t => t.status !== "done"); if (open) return { type: "task", title: open.title, taskId: open.id, priority: open.priority }; return { type: "setup", title: "Create your first task or goal" }; }
function dailyPlan() { return { generatedAt: new Date().toISOString(), tasks: tasks.filter(t => t.status !== "done").sort((a,b) => ({high:0,normal:1,low:2}[a.priority] ?? 1) - ({high:0,normal:1,low:2}[b.priority] ?? 1)).slice(0,5), nextAction: nextAction() }; }
function contextSummary() { return { memoryCount: memory.length, taskCount: tasks.length, openTasks: tasks.filter(t => t.status !== "done").length, goalCount: goals.length, knowledgeCount: knowledge.length }; }
function addConversation(role, content) { conversation.push({ id: `turn_${Date.now()}_${Math.random().toString(36).slice(2,7)}`, role, content: String(content || "").slice(0,5000), at: new Date().toISOString() }); conversation = conversation.slice(-MAX.conversation); writeJson(FILES.conversation, conversation); }
function conversationContext(limit = 12) { return conversation.slice(-limit).map(turn => ({ role: turn.role === "assistant" ? "model" : "user", parts: [{ text: turn.content }] })); }

async function generateAIResponse(message, extraContext = "", useWeb = false) {
  const apiKey = process.env.GEMINI_API_KEY; if (!apiKey) return { success:false, error:"AI provider is not configured" };
  const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  const system = ["You are Amvexa, a personal AI assistant for one user.","You are not a command parser. Hold a natural, continuous conversation.","You are Amvexa, the user's own personal assistant software. Never claim that Amazon, Google, OpenAI, or another company created you unless the user explicitly asks about the underlying model/provider.","Understand Hindi, Hinglish and English and normally reply in natural Hindi/Hinglish unless the user asks otherwise.","Be concise but thoughtful. Do not repeat generic greetings or ask what you can do after every message.","Use recent conversation context and relevant remembered facts.","Never claim an action happened unless the execution result confirms it.","When current information is needed, use supplied web research rather than inventing facts.","You may suggest the next useful step when appropriate, without being pushy.",extraContext].filter(Boolean).join("\n");
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { method:"POST", body:JSON.stringify({ system_instruction:{parts:[{text:system}]}, contents:[...conversationContext(),{role:"user",parts:[{text:message}]}], ...(useWeb?{tools:[{google_search:{}}]}:{}), generationConfig:{temperature:0.7,maxOutputTokens:700} }), headers:{"Content-Type":"application/json","x-goog-api-key":apiKey}, signal:controller.signal });
    const data = await response.json().catch(()=>({})); if(!response.ok){ const providerError=data?.error?.message||"AI provider request failed"; console.error("Gemini error:",response.status,providerError); return {success:false,error:providerError}; }
    const text=data?.candidates?.[0]?.content?.parts?.map(p=>p.text||"").join("").trim(); if(!text){ console.error("Gemini returned no text:",JSON.stringify(data).slice(0,2000)); return {success:false,error:"AI provider returned no response"}; }
    return {success:true,text};
  } catch(error){ return {success:false,error:error?.name==="AbortError"?"AI provider timed out":"AI provider unavailable"}; } finally{clearTimeout(timeout);}
}

async function buildAssistantResponse(message, toolResult, useWeb=false) { const memoryContext=memorySearch(message,5).map(m=>m.content).join("\n"); const webContext=toolResult?.success&&toolResult?.results?.length?toolResult.results.slice(0,6).map(r=>`${r.title}\n${r.content}\n${r.url}`).join("\n\n"):""; const extra=[memoryContext?`Relevant remembered facts:\n${memoryContext}`:"",webContext?`Fresh web research:\n${webContext}`:""].filter(Boolean).join("\n\n"); return generateAIResponse(message,extra,useWeb); }

async function webSearch(query) {
  const apiKey=process.env.TAVILY_API_KEY; if(!apiKey)return {success:false,error:"Web intelligence is not configured",results:[]};
  const controller=new AbortController(); const timeout=setTimeout(()=>controller.abort(),12000);
  try{ const response=await fetch("https://api.tavily.com/search",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({api_key:apiKey,query:String(query||"").trim()+( /\b(news|khabar|today|aaj|latest|current|recent)\b/i.test(String(query||""))?" Give the answer in Hindi. For each story, include the source name and publication date when available.":" Answer in Hindi."),search_depth:"advanced",max_results:6,include_answer:true,include_raw_content:false}),signal:controller.signal}); const data=await response.json().catch(()=>({})); if(!response.ok)return {success:false,error:data?.detail||data?.message||"Web search failed",results:[]}; return {success:true,answer:data?.answer||"",results:Array.isArray(data?.results)?data.results.map(item=>({title:item.title||"",url:item.url||"",content:String(item.content||"").slice(0,2500),score:item.score,published_date:item.published_date||item.publishedAt||item.date||""})):[]}; }catch(error){return {success:false,error:error?.name==="AbortError"?"Web search timed out":"Web search unavailable",results:[]};}finally{clearTimeout(timeout);}
}
function formatWebResponse(result){ if(!result?.success)return result?.error==="Web intelligence is not configured"?"Web intelligence abhi connected nahi hai. TAVILY_API_KEY configure hone ke baad main live internet research kar sakta hoon.":"Web research abhi complete nahi ho payi."; const lines=[]; if(result.answer)lines.push(result.answer.trim()); if(result.results?.length){lines.push("","Sources:"); result.results.forEach((item,index)=>{lines.push((index+1)+". "+(item.title||item.url));if(item.published_date)lines.push("   Date: "+item.published_date);if(item.url)lines.push("   Source: "+item.url);});} return lines.join("\n"); }
function knowledgeSearch(query){ const terms=String(query||"").toLowerCase().split(/\s+/).filter(x=>x.length>1); return knowledge.map(item=>{const text=`${item.name} ${item.text}`.toLowerCase();const score=terms.reduce((n,term)=>n+(text.includes(term)?1:0),0);return {item,score};}).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,8).map(x=>({id:x.item.id,name:x.item.name,text:x.item.text.slice(0,2000),score:x.score})); }
function planTool(message){ const intent=detectIntent(message); if(intent==="memory"){const content=/\b(hindi|हिंदी)\b/i.test(message)?"Mujhe hamesha Hindi mein jawab dena hai.":extractMemory(message);return {tool:"save_memory",args:{content,kind:/\b(hindi|हिंदी)\b/i.test(message)?"preference":"saved-memory"}};} if(intent==="recall")return {tool:"recall_memory",args:{query:message}}; if(intent==="task_complete")return {tool:"complete_task",args:{reference:message}}; if(intent==="music")return {tool:"music_search",args:{query:message}}; if(intent==="tasks")return {tool:"get_tasks",args:{}}; if(intent==="planning"){let title=taskFromMessage(message); const isExplicitTask=/\b(?:ek\s+)?(?:task|tast|todo)\s+(?:add|create|bana)\s+(?:karo|karna|do)\b/i.test(message)||/\b(?:add|create|creat|make|set|new)\s+(?:a\s+)?(?:task|tast|todo)\b/i.test(message); const isImplicitTask=/^\s*(?:kal|tomorrow|aaj|today)\b.+\b(?:karna|karne|complete|finish|niptana|niptane)\b/i.test(message); if(isImplicitTask&&!isExplicitTask) title=message.replace(/^\s*(?:kal|tomorrow|aaj|today)\b\s*/i,"").trim(); if((isExplicitTask||isImplicitTask)&&title)return {tool:"create_task",args:{title,priority:/\b(high|urgent|important|jaruri|zaroori)\b/i.test(message)?"high":"normal"}}; return {tool:"get_daily_plan",args:{}};} if(intent==="research"||/\b(news|khabar|today|aaj|latest|current|recent|source|sources|date|tarikh|internet|web|online)\b/i.test(message))return {tool:"web_search",args:{query:message}}; return {tool:null,args:{}}; }
async function executeTool(tool,args={}){ let result; switch(tool){case"save_memory":result={success:true,memory:remember(args.content,args.kind||"saved-memory")};break;case"recall_memory":result={success:true,memories:memorySearch(args.query)};break;case"create_task":result={success:true,task:createTask(args.title,args.priority)};break;case"complete_task":result=completeTask(args.reference);break;case"music_search":result={success:true,action:{type:"music",query:String(args.query||"").trim()||"romantic songs",url:"https://youtube.com/playlist?list=PL-ER7jNwYADztaCaTFnTMGBoGWaIUQ0K4&si=6o-Ln9w2WHvlUKgt",playlist:true}};break;case"get_tasks":result={success:true,tasks};break;case"get_daily_plan":result={success:true,plan:dailyPlan()};break;case"get_next_action":result={success:true,nextAction:nextAction()};break;case"search_knowledge":result={success:true,results:knowledgeSearch(args.query)};break;case"web_search":result=await webSearch(args.query);break;default:return {success:false,error:"Tool not allowed"};} logAction(tool,args,result); return result; }
function verifyTool(tool,result){ if(!result||result.success!==true)return {verified:false,reason:result?.error||"Tool failed"}; if(tool==="save_memory")return {verified:Boolean(result.memory?.id),reason:"Memory record verified"}; if(tool==="create_task"){const id=result.task?.id;return {verified:Boolean(id&&tasks.some(t=>t.id===id)),reason:"Task existence verified"};} if(tool==="complete_task"){const id=result.task?.id;const task=tasks.find(t=>t.id===id);return {verified:Boolean(task&&task.status==="done"),reason:"Task completion verified"};} return {verified:true,reason:"Result structure verified"}; }

function localBrain(message, aiError="") {
  const text=String(message||"").trim(); const lower=text.toLowerCase(); const intent=detectIntent(text);
  if(/hindi.*(nahi|nahin).*aati|hindi.*samajh|hindi.*aati.*kya/.test(lower))return "Aati hai. Aap Hindi mein bilkul baat kijiye.";
  if(intent==="greeting")return "Namaste! Main Amvexa hoon. Aap batayiye, main kya karun?";
  if(intent==="memory"){const content=extractMemory(text);return content?`Theek hai, maine yaad rakh liya: "${content}"`:"Bilkul. Jo baat aap chahte hain ki main yaad rakhun, woh bataiye.";}
  if(intent==="recall"){
    let found=memorySearch(text);
    if(/\b(mera naam|my name|what is my name|what\x27s my name)\b/i.test(text))found=memory.filter(m=>/\b(user ka naam|mera naam|my name|name|naam)\b/i.test(m.content)).slice(-8);
    if(!found.length)return "Abhi mujhe matching memory nahi mili.";
    const name=found.find(m=>/^User ka naam\s+.+$/i.test(m.content))?.content.match(/^User ka naam\s+(.+)$/i)?.[1]?.trim();
    if(/\b(mera naam|my name|what is my name|what\x27s my name)\b/i.test(text)&&name)return `Aapka naam ${name} hai.`;
    return found.map((m,i)=>`${i+1}. ${m.content}`).join("\n");
  }
  if(intent==="tasks"){const open=tasks.filter(t=>t.status!=="done");return open.length?open.map((t,i)=>`${i+1}. ${t.title} (${t.priority})`).join("\n"):"Aaj ke liye koi open task nahi hai.";}
  if(intent==="planning"){const plan=dailyPlan();if(!plan.tasks.length)return "Aaj ke liye koi open task nahi hai. Aap chahein to main aapke liye daily plan bana sakta hoon.";return ["Aaj ka plan:",...plan.tasks.map((t,i)=>`${i+1}. ${t.title} — ${t.priority}`),`Next action: ${plan.nextAction.title}`].join("\n");}
  if(intent==="research"){const results=knowledgeSearch(text);return results.length?results.map((r,i)=>`${i+1}. ${r.name}: ${r.text}`).join("\n"):"Main is topic ko research kar sakta hoon, lekin abhi web intelligence connected nahi hai.";}
  if(intent==="question"){
    if(/^\s*(mera naam kya|what is my name|what's my name|my name)\b/i.test(lower)){const found=memory.find(m=>/\b(?:name|naam)\b/i.test(m.content));if(found){const name=found.content.match(/^User ka naam\s+(.+)$/i)?.[1]?.trim();return name?`Aapka naam ${name} hai.`:found.content;}return "Abhi mujhe aapka naam yaad nahi hai. Aap ek baar bata dijiye: “Mera naam ___ hai”, main yaad rakh loonga.";}
    if(/who are you|tum kaun|aap kaun|what are you|tum kya ho|aap kya ho|tumhara naam|aapka naam|what is your name|what's your name/.test(lower))return "Main Amvexa hoon — aapka personal AI assistant. Main aapse naturally baat karta hoon, aapki baatein yaad rakh sakta hoon, tasks aur planning sambhal sakta hoon, aur zarurat par internet se current information research kar sakta hoon.";
    if(/how are you|kaise ho|kaisi ho/.test(lower))return "Main ready hoon. Aap jo kaam ya sawaal denge, usi ke hisaab se help karunga.";
  }
  if(aiError)return `AI brain abhi available nahi hai. Technical error: ${aiError}`;
  return "Samajh gaya. Aap bataiye, main kis tarah help karun?";
}

app.get("/api/health", (req,res)=>res.json({success:true,service:"amvexa-ai",version:VERSION,release:RELEASE}));
app.get("/api/memory", (req,res)=>res.json({success:true,memory}));
app.get("/api/tasks", (req,res)=>res.json({success:true,tasks}));
app.get("/api/context", (req,res)=>res.json({success:true,context:contextSummary()}));
app.get("/api/conversation", (req,res)=>res.json({success:true,conversation:conversation.slice(-MAX.conversation)}));
app.get("/api/proactive", (req,res)=>res.json({success:true,shouldSpeak:false,message:""}));

app.post("/api/chat", async (req,res)=>{
  const message=String(req.body?.message||"").trim();
  if(!message)return res.status(400).json({success:false,error:"Message is required"});
  addConversation("user",message);
  const plan=planTool(message);
  let toolResult=null; let verification=null; let responseText="";
  try{
    if(plan.tool){toolResult=await executeTool(plan.tool,plan.args);verification=verifyTool(plan.tool,toolResult);}
    if(plan.tool==="save_memory"&&verification?.verified){responseText=`Theek hai, maine yaad rakh liya: "${toolResult.memory.content}"`;
    }else if(plan.tool==="recall_memory"){
      const found=toolResult?.memories||[]; const name=found.find(m=>/^User ka naam\s+.+$/i.test(m.content))?.content.match(/^User ka naam\s+(.+)$/i)?.[1]?.trim(); responseText=(/\b(mera naam|my name|what is my name|what's my name)\b/i.test(message)&&name)?`Aapka naam ${name} hai.`:found.length?found.map((m,i)=>`${i+1}. ${m.content}`).join("\n"):"Abhi mujhe matching memory nahi mili.";
    }else if(plan.tool==="web_search"){responseText=formatWebResponse(toolResult);}
    else if(plan.tool){responseText=JSON.stringify(toolResult);}
    else {const ai=await buildAssistantResponse(message,null,false);responseText=ai.success?ai.text:localBrain(message,ai.error);}
  }catch(error){responseText=localBrain(message,error?.message||"Unknown error");}
  addConversation("assistant",responseText);
  return res.json({success:true,response:responseText,tool:plan.tool||null,verification,data:{understanding:{intent:plan.tool==="create_task"?"planning":plan.tool==="complete_task"?"task_complete":plan.tool==="get_tasks"?"tasks":detectIntent(message)}}});
});

app.listen(PORT,()=>console.log(`Amvexa AI ${VERSION} ${RELEASE} listening on ${PORT}`));
