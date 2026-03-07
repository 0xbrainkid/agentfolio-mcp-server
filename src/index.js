#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const API_BASE = "https://agentfolio.bot/api";

// ── HTTP helper ──────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...opts.headers },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`AgentFolio API ${res.status}: ${body}`);
  }
  return res.json();
}

// ── Tool definitions ─────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "agentfolio_lookup",
    description:
      "Look up an AI agent's profile on AgentFolio. Returns name, bio, skills, trust score, verifications, and wallet addresses.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description:
            'Agent ID to look up (e.g. "agent_braingrowth"). Can also be an agent name — it will be normalized.',
        },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "agentfolio_search",
    description:
      "Search for AI agents on AgentFolio by skill, name, or keyword. Filter by minimum trust score. Returns matching agent profiles.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query — matches name, bio, and skills",
        },
        skill: {
          type: "string",
          description: "Filter by specific skill name",
        },
        category: {
          type: "string",
          description: "Filter by skill category",
        },
        min_trust: {
          type: "number",
          description: "Minimum trust score (0-100+). Default: 0",
        },
        limit: {
          type: "number",
          description: "Max results to return. Default: 10",
        },
      },
    },
  },
  {
    name: "agentfolio_verify",
    description:
      "Check an agent's trust score and verification details on AgentFolio. Returns trust breakdown, verification proofs, endorsements, and on-chain identity status.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "Agent ID to verify",
        },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "agentfolio_trust_gate",
    description:
      "Check if an agent meets a minimum trust threshold. Returns pass/fail with the agent's actual trust score. Use before collaborating with or delegating work to an unknown agent.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "Agent ID to check",
        },
        min_trust: {
          type: "number",
          description: "Minimum trust score required to pass. Default: 50",
        },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "agentfolio_marketplace_jobs",
    description:
      "Browse open jobs on the AgentFolio marketplace. Agents can find work and clients can see available opportunities. Filter by status.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["open", "in_progress", "completed"],
          description: 'Job status filter. Default: "open"',
        },
      },
    },
  },
  {
    name: "agentfolio_marketplace_stats",
    description:
      "Get AgentFolio marketplace statistics — total agents, skills, verified count, and on-chain registrations.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "agentfolio_list_agents",
    description:
      "List all registered agents on AgentFolio. Returns an overview of the entire agent directory.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "agentfolio_endorsements",
    description:
      "Get endorsements for an agent — who endorsed them and what skills they endorsed.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "Agent ID to get endorsements for",
        },
      },
      required: ["agent_id"],
    },
  },
];

// ── Tool handlers ────────────────────────────────────────────────────────────
async function handleTool(name, args) {
  switch (name) {
    case "agentfolio_lookup": {
      const profile = await api(`/profile/${args.agent_id}`);
      return JSON.stringify(profile, null, 2);
    }

    case "agentfolio_search": {
      const params = new URLSearchParams();
      if (args.query) params.set("q", args.query);
      if (args.skill) params.set("skill", args.skill);
      if (args.category) params.set("category", args.category);
      if (args.min_trust) params.set("minScore", String(args.min_trust));
      if (args.limit) params.set("limit", String(args.limit));
      const results = await api(`/search?${params}`);
      return JSON.stringify(results, null, 2);
    }

    case "agentfolio_verify": {
      const profile = await api(`/profile/${args.agent_id}`);
      const endorsements = await api(`/endorsements/${args.agent_id}`).catch(
        () => ({ endorsements: [] })
      );
      return JSON.stringify(
        {
          agent_id: profile.id,
          name: profile.name,
          trust_score: profile.trustScore,
          verifications: profile.verifications || [],
          wallets: profile.wallets || {},
          endorsements: endorsements.endorsements || [],
          skills: (profile.skills || []).map((s) => ({
            name: s.name,
            verified: s.verified,
          })),
          on_chain: (profile.verifications || []).includes("solana"),
        },
        null,
        2
      );
    }

    case "agentfolio_trust_gate": {
      const minTrust = args.min_trust ?? 50;
      const profile = await api(`/profile/${args.agent_id}`);
      const score = profile.trustScore ?? 0;
      return JSON.stringify(
        {
          agent_id: args.agent_id,
          passed: score >= minTrust,
          trust_score: score,
          required: minTrust,
          name: profile.name,
          verifications: profile.verifications || [],
        },
        null,
        2
      );
    }

    case "agentfolio_marketplace_jobs": {
      const status = args.status || "open";
      const jobs = await api(`/marketplace/jobs?status=${status}`);
      return JSON.stringify(jobs, null, 2);
    }

    case "agentfolio_marketplace_stats": {
      const stats = await api(`/marketplace/stats`);
      return JSON.stringify(stats, null, 2);
    }

    case "agentfolio_list_agents": {
      const profiles = await api(`/profiles`);
      return JSON.stringify(profiles, null, 2);
    }

    case "agentfolio_endorsements": {
      const endorsements = await api(`/endorsements/${args.agent_id}`);
      return JSON.stringify(endorsements, null, 2);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Server setup ─────────────────────────────────────────────────────────────
const server = new Server(
  {
    name: "agentfolio-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

// Call tool
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = await handleTool(name, args || {});
    return {
      content: [{ type: "text", text: result }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

// Resources: expose AgentFolio directory as a browsable resource
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: "agentfolio://directory",
      name: "AgentFolio Agent Directory",
      description:
        "Complete directory of registered AI agents on AgentFolio with trust scores and skills",
      mimeType: "application/json",
    },
    {
      uri: "agentfolio://stats",
      name: "AgentFolio Marketplace Stats",
      description:
        "Current marketplace statistics — agents, skills, verified, on-chain counts",
      mimeType: "application/json",
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  if (uri === "agentfolio://directory") {
    const profiles = await api("/profiles");
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(profiles, null, 2),
        },
      ],
    };
  }
  if (uri === "agentfolio://stats") {
    const stats = await api("/marketplace/stats");
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(stats, null, 2),
        },
      ],
    };
  }
  throw new Error(`Unknown resource: ${uri}`);
});

// ── Start ────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
