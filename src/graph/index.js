// src/graph/index.js
import { StateGraph, END, MemorySaver } from '@langchain/langgraph';
import { ToolNode }                      from '@langchain/langgraph/prebuilt';
import { AgentState }                    from '../agents/state.js';
import { rahulNode }                     from '../agents/companyAgents.js';
import { checkAvailabilityTool, bookAppointmentTool } from '../tools/calendar.js';
import { sendMeetingEmailTool }          from '../tools/email.js';
import logger                            from '../utils/logger.js';

const memory   = new MemorySaver();
const workflow = new StateGraph(AgentState);

// ── Tool node — handles all three tools Rahul can call ────────────────────────
const toolNode = new ToolNode([
  checkAvailabilityTool,
  bookAppointmentTool,
  sendMeetingEmailTool,
]);

// ── Nodes ─────────────────────────────────────────────────────────────────────
workflow.addNode('rahul', rahulNode);
workflow.addNode('tools', toolNode);

// ── Entry point ───────────────────────────────────────────────────────────────
workflow.addEdge('__start__', 'rahul');

// ── Tool loop: if Rahul called a tool → run it → return to Rahul ──────────────
workflow.addConditionalEdges(
  'rahul',
  (state) => {
    const last = state.messages[state.messages.length - 1];
    if (last?.tool_calls?.length > 0) {
      logger.debug('[Graph] Rahul → tools', { tools: last.tool_calls.map(t => t.name) });
      return 'tools';
    }
    logger.debug('[Graph] Rahul → END');
    return END; 
  },
  { tools: 'tools', [END]: END },
);

// Tool results feed back into Rahul so he can continue the conversation
workflow.addEdge('tools', 'rahul');

// ── Compile ───────────────────────────────────────────────────────────────────
export const graph = workflow.compile({ checkpointer: memory });

logger.info('[Graph] Compiled — single Rahul agent with tool loop');