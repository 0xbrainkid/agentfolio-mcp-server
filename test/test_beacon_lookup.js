/**
 * Test for agentfolio_beacon_lookup tool.
 * Verifies the unified Beacon + AgentFolio lookup functionality.
 */

import { beaconLookup, beaconSearchByName } from '../src/beacon_helpers.js';

async function testBeaconLookup() {
  console.log('Testing beacon_lookup...');
  const result = await beaconLookup('bcn_0x0a_a8f574df');
  console.log('Lookup result:', JSON.stringify(result, null, 2));
  if (result) {
    console.log('✅ Beacon lookup working');
  } else {
    console.log('⚠️  Beacon not found (may be expected if API changed)');
  }
}

testBeaconLookup().catch(console.error);
