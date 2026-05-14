/**
 * Jupiter Trigger Order API V2 Client
 * Handles challenge-response JWT authentication, custodial Vault provisioning,
 * and advanced OTOCO bundled trade routing.
 */

import { Buffer } from "node:buffer";
import * as ows from "../wallet/keystore.js";

const BASE_URL = "https://api.jup.ag/trigger/v2";
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Native JS Buffer to Base58 encoder using BigInt.
 */
function bufferToBase58(buffer) {
  if (buffer.length === 0) return "";
  let x = BigInt("0x" + buffer.toString("hex"));
  const output = [];
  while (x > 0n) {
    const mod = Number(x % 58n);
    x = x / 58n;
    output.push(BASE58_ALPHABET[mod]);
  }
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0) {
      output.push(BASE58_ALPHABET[0]);
    } else {
      break;
    }
  }
  return output.reverse().join("");
}

let _cachedJwt = null;
let _jwtExpiresAt = 0;

/**
 * Authenticate with Jupiter using Challenge-Response flow.
 * Caches the JWT token in-memory for 23 hours.
 */
export async function getJwtToken(walletName, walletAddress, passphrase) {
  const apiKey = process.env.JUPITER_API_KEY;
  if (!apiKey) {
    throw new Error("JUPITER_API_KEY is missing from environment variables.");
  }

  if (_cachedJwt && Date.now() < _jwtExpiresAt) {
    return _cachedJwt;
  }

  // 1. Request challenge
  const challengeRes = await fetch(`${BASE_URL}/auth/challenge`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      walletPubkey: walletAddress,
      type: "message",
    }),
  });

  if (!challengeRes.ok) {
    const errText = await challengeRes.text();
    throw new Error(`Jupiter Auth Challenge failed: ${challengeRes.status} - ${errText}`);
  }

  const challengeData = await challengeRes.json();

  // 2. Sign challenge message using OWS
  // ows.signMessage returns an object containing the hex signature
  const signResult = ows.signMessage(walletName, challengeData.challenge, passphrase, "utf8", "solana");
  const signatureBuffer = Buffer.from(signResult.signature, "hex");
  const base58Signature = bufferToBase58(signatureBuffer);

  // 3. Verify signature and get JWT
  const verifyRes = await fetch(`${BASE_URL}/auth/verify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      type: "message",
      walletPubkey: walletAddress,
      signature: base58Signature,
    }),
  });

  if (!verifyRes.ok) {
    const errText = await verifyRes.text();
    throw new Error(`Jupiter Auth Verify failed: ${verifyRes.status} - ${errText}`);
  }

  const { token } = await verifyRes.json();
  _cachedJwt = token;
  // Set cache expiry to 23 hours (JWT TTL is 24h)
  _jwtExpiresAt = Date.now() + 23 * 60 * 60 * 1000;

  return token;
}

/**
 * Get or register the user's custodial Privy Vault.
 */
export async function getVault(token) {
  const apiKey = process.env.JUPITER_API_KEY;
  let vaultRes = await fetch(`${BASE_URL}/vault`, {
    headers: {
      "x-api-key": apiKey,
      "Authorization": `Bearer ${token}`,
    },
  });

  if (!vaultRes.ok) {
    if (vaultRes.status === 404) {
      // Register new vault
      vaultRes = await fetch(`${BASE_URL}/vault/register`, {
        headers: {
          "x-api-key": apiKey,
          "Authorization": `Bearer ${token}`,
        },
      });
      if (!vaultRes.ok) {
        const errText = await vaultRes.text();
        throw new Error(`Jupiter Vault Registration failed: ${vaultRes.status} - ${errText}`);
      }
    } else {
      const errText = await vaultRes.text();
      throw new Error(`Jupiter Vault lookup failed: ${vaultRes.status} - ${errText}`);
    }
  }

  return vaultRes.json();
}

/**
 * Craft a deposit transaction for an OTOCO/single order payload.
 */
export async function craftDeposit(token, { inputMint, outputMint, userAddress, amount, orderSubType = "otoco" }) {
  const apiKey = process.env.JUPITER_API_KEY;
  const res = await fetch(`${BASE_URL}/deposit/craft`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({
      inputMint,
      outputMint,
      userAddress,
      amount: amount.toString(),
      orderType: "price",
      orderSubType,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Jupiter Deposit Craft failed: ${res.status} - ${errText}`);
  }

  return res.json();
}

/**
 * Create a bundled OTOCO Trigger Order.
 */
export async function createOtocoOrder(token, payload) {
  const apiKey = process.env.JUPITER_API_KEY;
  const res = await fetch(`${BASE_URL}/orders/price`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Jupiter OTOCO Order Creation failed: ${res.status} - ${errText}`);
  }

  return res.json();
}

/**
 * Fetch active or past order history.
 */
export async function getOrderHistory(token, state = "active", limit = 20) {
  const apiKey = process.env.JUPITER_API_KEY;
  const res = await fetch(`${BASE_URL}/orders/history?state=${state}&limit=${limit}`, {
    headers: {
      "x-api-key": apiKey,
      "Authorization": `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Jupiter Order History lookup failed: ${res.status} - ${errText}`);
  }

  return res.json();
}
