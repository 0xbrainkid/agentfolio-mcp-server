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

// ── OATR Integration (Open Agent Trust Registry) ─────────────────────────────
// Two-layer identity: OATR (off-chain operator) + SATP (on-chain reputation)
let oatrAvailable = false;
let verifyAttestation, OpenAgentTrustRegistry;
try {
  const oatr = await import("@open-agent-trust/registry");
  verifyAttestation = oatr.verifyAttestation;
  OpenAgentTrustRegistry = oatr.OpenAgentTrustRegistry || oatr.default;
  if (verifyAttestation || OpenAgentTrustRegistry) {
    oatrAvailable = true;
    console.error("[agentfolio-mcp] OATR integration enabled");
  }
} catch {
  console.error("[agentfolio-mcp] OATR not available (optional dependency)");
}

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
  // Guard against HTML error pages returned with 200
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    const body = await res.text().catch(() => "");
    if (body.includes("<!DOCTYPE") || body.includes("<html")) {
      throw new Error(`AgentFolio API returned HTML instead of JSON for ${path}`);
    }
  }
  return res.json();
}

// Soft API call — returns fallback on error instead of throwing
async function apiSoft(path, fallback = null) {
  try {
    return await api(path);
  } catch {
    return fallback;
  }
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
    name: "agentfolio_verify_operator",
    description:
      "Verify an agent's operator identity via OATR (Open Agent Trust Registry). Returns off-chain operator verification status alongside on-chain SATP reputation. Two-layer identity: who RUNS the agent (OATR) + how TRUSTED the agent is (SATP).",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "Agent ID to check operator identity for",
        },
        token: {
          type: "string",
          description: "OATR attestation token to verify (optional — if not provided, checks AgentFolio profile for linked OATR identity)",
        },
      },
      required: ["agent_id"],
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
      // /api/search is currently unavailable — fall back to client-side filtering of /api/profiles
      const profilesData = await api("/profiles");
      const allProfiles = profilesData.profiles || [];
      const query = (args.query || "").toLowerCase();
      const minTrust = args.min_trust || 0;
      const limit = args.limit || 10;

      let filtered = allProfiles;
      if (query) {
        filtered = filtered.filter((p) => {
          const name = (p.name || "").toLowerCase();
          const bio = (p.bio || p.description || "").toLowerCase();
          const skills = (p.skills || [])
            .map((s) => (typeof s === "string" ? s : s.name || "").toLowerCase())
            .join(" ");
          return name.includes(query) || bio.includes(query) || skills.includes(query);
        });
      }
      if (minTrust > 0) {
        filtered = filtered.filter((p) => (p.trustScore || 0) >= minTrust);
      }
      if (args.skill) {
        const sk = args.skill.toLowerCase();
        filtered = filtered.filter((p) =>
          (p.skills || []).some((s) =>
            (typeof s === "string" ? s : s.name || "").toLowerCase().includes(sk)
          )
        );
      }
      if (args.category) {
        const cat = args.category.toLowerCase();
        filtered = filtered.filter((p) =>
          (p.skills || []).some(
            (s) => typeof s === "object" && (s.category || "").toLowerCase().includes(cat)
          )
        );
      }

      return JSON.stringify(
        {
          query: args.query || "",
          count: filtered.length,
          results: filtered.slice(0, limit),
          note: "Search performed client-side against agent directory. Some profile fields may be limited.",
          totalRegistered: profilesData.total || 0,
        },
        null,
        2
      );
    }

    case "agentfolio_verify": {
      const profile = await api(`/profile/${args.agent_id}`);
      // Endorsement endpoints are currently unavailable
      const endorsements = await apiSoft(
        `/profile/${args.agent_id}/endorsements`,
        await apiSoft(`/endorsements/${args.agent_id}`, { received: [], given: [] })
      );
      return JSON.stringify(
        {
          agent_id: profile.id,
          name: profile.name,
          trust_score: profile.trustScore ?? null,
          verifications: profile.verifications || [],
          wallets: profile.wallets || {},
          endorsements_received: endorsements?.received || endorsements?.endorsements || [],
          endorsements_given: endorsements?.given || [],
          skills: (profile.skills || []).map((s) => ({
            name: typeof s === "string" ? s : s.name,
            verified: typeof s === "object" ? s.verified : undefined,
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
      // /marketplace/stats endpoint is currently unavailable — compute from available data
      const [profilesData, jobsData] = await Promise.all([
        apiSoft("/profiles", { profiles: [], total: 0 }),
        apiSoft("/marketplace/jobs", { jobs: [], total: 0 }),
      ]);
      return JSON.stringify(
        {
          totalAgents: profilesData.total || (profilesData.profiles || []).length,
          totalJobs: jobsData.total || (jobsData.jobs || []).length,
          openJobs: (jobsData.jobs || []).filter((j) => j.status === "open").length,
          note: "Stats computed from available API endpoints. Some metrics may be approximate.",
        },
        null,
        2
      );
    }

    case "agentfolio_list_agents": {
      const profiles = await api(`/profiles`);
      return JSON.stringify(profiles, null, 2);
    }

    case "agentfolio_verify_operator": {
      const profile = await api(`/profile/${args.agent_id}`);
      const satpTrust = profile.trustScore ?? 0;
      const verifs = profile.verifications || {};
      const verifsArr = Array.isArray(verifs) ? verifs : Object.keys(verifs).filter(k => verifs[k]);
      const satpOnChain = verifsArr.includes("solana") || !!verifs.solana;
      
      let oatrResult = null;
      if (oatrAvailable) {
        try {
          if (args.token && verifyAttestation) {
            // Verify a specific OATR attestation token
            oatrResult = await verifyAttestation(args.token);
          } else {
            // Check if agent has OATR-linked identity via wallet key
            const wallets = profile.wallets || {};
            const solanaAddr = wallets.solana || wallets.sol;
            oatrResult = {
              checked: true,
              linked: false,
              note: solanaAddr 
                ? `Agent has Solana wallet ${solanaAddr}. OATR operator lookup requires attestation token or DID.`
                : "No Solana wallet linked. Cannot cross-reference with OATR operator registry.",
            };
          }
        } catch (err) {
          oatrResult = { checked: true, error: err.message };
        }
      } else {
        oatrResult = {
          checked: false,
          note: "OATR integration not available. Install @open-agent-trust/registry for two-layer identity verification.",
        };
      }
      
      return JSON.stringify({
        agent_id: args.agent_id,
        name: profile.name,
        two_layer_identity: {
          layer1_oatr: {
            description: "Off-chain operator identity (who runs this agent)",
            ...oatrResult,
          },
          layer2_satp: {
            description: "On-chain agent reputation (how trusted is this agent)",
            trust_score: satpTrust,
            on_chain: satpOnChain,
            verifications: verifsArr,
          },
        },
        combined_assessment: satpOnChain 
          ? `Agent has on-chain SATP identity (trust: ${satpTrust}). ${oatrResult?.linked ? "OATR operator verified." : "OATR operator not yet linked."}`
          : `Agent registered but no on-chain identity yet. Trust score: ${satpTrust}.`,
      }, null, 2);
    }

    case "agentfolio_endorsements": {
      // Try both possible endorsement endpoints
      const endorsements = await apiSoft(
        `/profile/${args.agent_id}/endorsements`,
        await apiSoft(`/endorsements/${args.agent_id}`, null)
      );
      if (!endorsements) {
        return JSON.stringify({
          agent_id: args.agent_id,
          error: "Endorsements endpoint is currently unavailable",
          note: "The AgentFolio endorsements API may be undergoing maintenance.",
        }, null, 2);
      }
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
    const [profilesData, jobsData] = await Promise.all([
      apiSoft("/profiles", { profiles: [], total: 0 }),
      apiSoft("/marketplace/jobs", { jobs: [], total: 0 }),
    ]);
    const stats = {
      totalAgents: profilesData.total || (profilesData.profiles || []).length,
      totalJobs: jobsData.total || (jobsData.jobs || []).length,
      openJobs: (jobsData.jobs || []).filter((j) => j.status === "open").length,
    };
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
