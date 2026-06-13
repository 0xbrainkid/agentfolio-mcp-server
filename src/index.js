#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const API_BASE = "https://agentfolio.bot/api";
const BEACON_DIRECTORY_URL = "https://bottube.ai/api/beacon/directory";

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
async function apiSoftResult(path, fallback = null) {
  try {
    return { data: await api(path), error: null };
  } catch (err) {
    return { data: fallback, error: err.message };
  }
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...opts.headers },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${url} ${res.status}: ${body}`);
  }
  return res.json();
}

async function fetchJsonSoft(url, fallback = null) {
  try {
    return { data: await fetchJson(url), error: null };
  } catch (err) {
    return { data: fallback, error: err.message };
  }
}

function asArray(data, keys) {
  if (Array.isArray(data)) {
    return data;
  }
  for (const key of keys) {
    if (Array.isArray(data?.[key])) {
      return data[key];
    }
  }
  return [];
}

function normalizeIdentity(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/^agent_/, "")
    .replace(/[^a-z0-9]/g, "");
}

function matchesIdentity(candidate, targets) {
  const normalized = targets.map(normalizeIdentity).filter(Boolean);
  if (normalized.length === 0) {
    return false;
  }
  const fields = [
    candidate.id,
    candidate.name,
    candidate.handle,
    candidate.agent_id,
    candidate.agentId,
    candidate.display_name,
  ];
  return fields.some((field) => normalized.includes(normalizeIdentity(field)));
}

function satpVerified(profile) {
  const verificationData = profile.verification_data || {};
  const verifications = profile.verifications || profile.verification || {};
  if (verificationData.satp?.verified || verificationData.satp_v3?.verified) {
    return true;
  }
  if (Array.isArray(verifications)) {
    return verifications.includes("satp") || verifications.includes("solana");
  }
  if (typeof verifications === "object" && verifications) {
    return Boolean(verifications.satp?.verified || verifications.solana?.verified || verifications.satp);
  }
  return false;
}

function buildProvenance(beacon) {
  if (!beacon) {
    return null;
  }
  const registered = beacon.registered ?? beacon.atlas_registered ?? !beacon.expired;
  return {
    beacon_id: beacon.beacon_id || beacon.agent_id || beacon.id,
    agent_name: beacon.agent_name || beacon.agent_id || null,
    display_name: beacon.display_name || beacon.name || null,
    is_human: Boolean(beacon.is_human),
    networks: beacon.networks || [],
    registered: Boolean(registered),
    expired: Boolean(beacon.expired || registered === false),
    source: BEACON_DIRECTORY_URL,
  };
}

function buildTrust(profile) {
  if (!profile) {
    return {
      status: "not_found",
      message: "No matching AgentFolio SATP profile found for this Beacon identity.",
    };
  }
  const score = profile.trustScore ?? profile.trust_score ?? null;
  const verified = satpVerified(profile);
  return {
    status: verified || (score ?? 0) > 0 ? "found" : "untrusted",
    agent_id: profile.id || profile.agent_id || null,
    name: profile.name || null,
    handle: profile.handle || null,
    trust_score: score,
    tier: profile.tier ?? null,
    verification_level: profile.verificationLevel ?? profile.verification_level ?? null,
    verification_badge: profile.verificationBadge ?? null,
    verification_level_name: profile.verificationLevelName ?? null,
    reputation_score: profile.reputationScore ?? profile.reputation_score ?? null,
    reputation_rank: profile.reputationRank ?? null,
    satp_verified: verified,
    wallets: profile.wallets || (profile.wallet ? { primary: profile.wallet } : {}),
    source: "https://agentfolio.bot/api/agents",
  };
}

async function unifiedBeaconLookup(args) {
  const beaconId = String(args.beacon_id || "").trim();
  if (!beaconId) {
    throw new Error("beacon_id is required");
  }

  const [beaconResult, agentsResult, profilesResult] = await Promise.all([
    fetchJsonSoft(BEACON_DIRECTORY_URL, { beacons: [] }),
    apiSoftResult("/agents?limit=200", { agents: [] }),
    apiSoftResult("/profiles?limit=200", { profiles: [] }),
  ]);

  const beacons = asArray(beaconResult.data, ["beacons", "results", "directory"]);
  const matchedBeacon = beacons.find((beacon) =>
    [beacon.beacon_id, beacon.agent_id, beacon.id].some((value) => value === beaconId)
  );
  const provenance = buildProvenance(matchedBeacon);

  const targets = [
    args.agent_id,
    args.agent_name,
    matchedBeacon?.satp_profile_id,
    matchedBeacon?.agent_name,
    matchedBeacon?.display_name,
  ];
  const agentfolioProfiles = [
    ...asArray(agentsResult.data, ["agents", "profiles", "results"]),
    ...asArray(profilesResult.data, ["profiles", "agents", "results"]),
  ];
  const matchedProfile = agentfolioProfiles.find((profile) => matchesIdentity(profile, targets));
  const trust = buildTrust(matchedProfile);

  const warnings = [];
  if (beaconResult.error) {
    warnings.push(`Beacon directory unavailable: ${beaconResult.error}`);
  }
  if (agentsResult.error) {
    warnings.push(`AgentFolio agents endpoint unavailable: ${agentsResult.error}`);
  }
  if (profilesResult.error) {
    warnings.push(`AgentFolio profiles endpoint unavailable: ${profilesResult.error}`);
  }
  if (!matchedBeacon) {
    warnings.push(`Beacon ID ${beaconId} was not found in the public Beacon directory.`);
  } else if (provenance.expired || !provenance.registered) {
    warnings.push("Beacon is present but not currently registered or verified.");
  }
  if (!matchedProfile) {
    warnings.push("AgentFolio SATP profile could not be matched by agent ID, name, or handle.");
  } else if (!trust.satp_verified) {
    warnings.push("Matched AgentFolio profile does not expose a verified SATP attestation.");
  }
  if ((trust.trust_score ?? 0) <= 0) {
    warnings.push("Trust score is missing or zero; treat this identity as untrusted until verified.");
  }

  const status = beaconResult.error
    ? "offline"
    : matchedBeacon && matchedProfile
      ? "found"
      : matchedBeacon || matchedProfile
        ? "partial"
        : "not_found";

  return {
    query: {
      beacon_id: beaconId,
      agent_id: args.agent_id || null,
      agent_name: args.agent_name || null,
    },
    status,
    provenance,
    trust,
    warnings,
    sources: {
      beacon_directory: BEACON_DIRECTORY_URL,
      agentfolio_agents: "https://agentfolio.bot/api/agents",
      agentfolio_profiles: "https://agentfolio.bot/api/profiles",
    },
  };
}

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
  {
    name: "agentfolio_beacon_lookup",
    description:
      "Look up a Beacon ID and return unified identity: Beacon provenance plus AgentFolio SATP trust score.",
    inputSchema: {
      type: "object",
      properties: {
        beacon_id: {
          type: "string",
          description: 'Beacon ID to resolve (for example "bcn_xeophon_a1078c86").',
        },
        agent_id: {
          type: "string",
          description: "Optional AgentFolio agent ID hint if the Beacon display name differs.",
        },
        agent_name: {
          type: "string",
          description: "Optional AgentFolio agent name or handle hint for SATP matching.",
        },
      },
      required: ["beacon_id"],
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

    case "agentfolio_beacon_lookup": {
      const result = await unifiedBeaconLookup(args);
      return JSON.stringify(result, null, 2);
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
export { TOOLS, handleTool, unifiedBeaconLookup };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
