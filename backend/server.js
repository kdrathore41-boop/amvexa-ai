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
app.post("/api/jarvis/execute", async (req,res)=>{
  const state=jarvisContext();
  const decision=buildDecision(state.nextAction);
  if(decision.operation!=="work_on_task"){