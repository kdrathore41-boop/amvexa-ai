app.post("/api/chat", async (req,res)=>{
  const message=String(req.body?.message||"").trim();
  if(!message)return res.status(400).json({success:false,error:"Message is required"});
  addConversation("user",message);
  const detectedIntent = detectIntent(message);
  // High-priority deterministic commands must bypass the generative AI fallback.
  const autonomousDirect = /^(?:khud\s+decide\s+karo|khud\s+decide\s+karna|khud\s+tay\s+karo|apne\s+aap\s+decide\s+karo|test\s+shuru\s+karo|khud\s+start\s+karo|start\s+the\s+test|decide\s+yourself\s+and\s+start)[.!?।\s]*$/i.test(message);
  // Reminder phrases are deterministic and must work even when the generative AI is unavailable.
  const reminderDirect = /(?:remind|reminder|yaad\s+dila(?:na|o)?|याद\s*दिलाना|याद\s*दिलाओ|bhoolna\s+mat|मत\s*भूलना)/i.test(message);
  const plan=autonomousDirect ? {tool:"jarvis_autonomous_step",args:{}} : reminderDirect ? {tool:"create_task",args:{title:"Reminder: "+message.replace(/(?:remind\s+me\s+to|remind\s+me|reminder|yaad\s+dilana|yaad\s+dila|याद\s*दिलाना|याद\s*दिलाओ|bhoolna\s+mat|मत\s*भूलना)/ig,"").replace(/[\s:,-]+/g," ").trim(),priority:"high",dueAt:extractDueAt(message)}} : planTool(message);
  updatePersonalAlgorithm(message, plan.tool === "create_task" ? "planning" : plan.tool === "get_tasks" ? "tasks" : plan.tool === "complete_task" ? "task_complete" : plan.tool || detectedIntent);
  let toolResult=null; let verification=null; let responseText="";
  try{