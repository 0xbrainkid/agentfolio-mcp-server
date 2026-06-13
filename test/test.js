import assert from "node:assert/strict";

import { TOOLS, handleTool, unifiedBeaconLookup } from "../src/index.js";

const originalFetch = globalThis.fetch;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetch(routes) {
  globalThis.fetch = async (url) => {
    const target = String(url);
    const route = routes.find(([matcher]) => target.includes(matcher));
    if (!route) {
      throw new Error(`Unexpected fetch: ${target}`);
    }
    const value = typeof route[1] === "function" ? route[1](target) : route[1];
    if (value instanceof Error) {
      throw value;
    }
    return jsonResponse(value);
  };
}

try {
  assert.equal(
    TOOLS.some((tool) => tool.name === "agentfolio_beacon_lookup"),
    true
  );

  installFetch([
    [
      "bottube.ai/api/beacon/directory",
      {
        beacons: [
          {
            beacon_id: "bcn_nomad_a1078c86",
            agent_name: "Nomad",
            display_name: "Nomad",
            networks: ["BoTTube"],
            registered: true,
          },
        ],
      },
    ],
    [
      "agentfolio.bot/api/agents",
      {
        agents: [
          {
            id: "agent_nomad",
            name: "Nomad",
            handle: "@nomad",
            trustScore: 91,
            tier: 2,
            verificationLevel: 3,
            verificationBadge: "verified",
            reputationScore: 900,
            reputationRank: "Expert",
            verifications: { satp: { verified: true } },
            wallets: { solana: "So11111111111111111111111111111111111111112" },
          },
        ],
      },
    ],
    ["agentfolio.bot/api/profiles", { profiles: [] }],
  ]);

  const direct = await unifiedBeaconLookup({ beacon_id: "bcn_nomad_a1078c86" });
  assert.equal(direct.status, "found");
  assert.equal(direct.provenance.agent_name, "Nomad");
  assert.equal(direct.trust.agent_id, "agent_nomad");
  assert.equal(direct.trust.trust_score, 91);
  assert.equal(direct.trust.satp_verified, true);

  const toolResult = JSON.parse(
    await handleTool("agentfolio_beacon_lookup", {
      beacon_id: "bcn_nomad_a1078c86",
    })
  );
  assert.equal(toolResult.status, "found");

  installFetch([
    ["bottube.ai/api/beacon/directory", { beacons: [] }],
    ["agentfolio.bot/api/agents", { agents: [] }],
    ["agentfolio.bot/api/profiles", { profiles: [] }],
  ]);

  const missing = JSON.parse(
    await handleTool("agentfolio_beacon_lookup", {
      beacon_id: "bcn_missing",
    })
  );
  assert.equal(missing.status, "not_found");
  assert.equal(missing.provenance, null);
  assert.equal(missing.trust.status, "not_found");
  assert.equal(missing.warnings.length >= 2, true);

  installFetch([
    ["bottube.ai/api/beacon/directory", new Error("network offline")],
    ["agentfolio.bot/api/agents", { agents: [] }],
    ["agentfolio.bot/api/profiles", { profiles: [] }],
  ]);

  const offline = await unifiedBeaconLookup({ beacon_id: "bcn_offline" });
  assert.equal(offline.status, "offline");
  assert.equal(
    offline.warnings.some((warning) => warning.includes("Beacon directory unavailable")),
    true
  );
} finally {
  globalThis.fetch = originalFetch;
}
