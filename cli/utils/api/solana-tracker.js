/**
 * Solana Tracker (Raptor) API Client
 * Optimized for ultra-low latency sniping.
 */

import { getConfigValue } from "../config.js";

const RAPTOR_BASE_URL = "https://raptor-beta.solanatracker.io";

/**
 * Build a swap transaction in a single request.
 */
export async function quoteAndSwap({
  userPublicKey,
  inputMint,
  outputMint,
  amount,
  slippage,
  priorityFee = "high",
  feeAccount,
  feeBps = 0,
}) {
  const body = {
    userPublicKey,
    inputMint,
    outputMint,
    amount: parseInt(amount.toString()), // Must be lamports (integer)
    slippageBps: slippage ? (parseFloat(slippage) * 100).toString() : "dynamic",
    txVersion: "v0",
    priorityFee,
    wrapUnwrapSol: true,
  };

  if (feeAccount && feeBps > 0) {
    body.feeAccount = feeAccount;
    body.feeBps = feeBps;
  }

  const response = await fetch(`${RAPTOR_BASE_URL}/quote-and-swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Solana Tracker Swap Error: ${response.status} - ${errorText}`);
  }

  return response.json();
}

/**
 * Send a signed transaction via Yellowstone Jet TPU.
 */
export async function sendTransaction(signedTxBase64) {
  const response = await fetch(`${RAPTOR_BASE_URL}/send-transaction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction: signedTxBase64 }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Solana Tracker Send Error: ${response.status} - ${errorText}`);
  }

  return response.json();
}

/**
 * Get the current status and details of a tracked transaction.
 */
export async function getTransactionStatus(signature) {
  const response = await fetch(`${RAPTOR_BASE_URL}/transaction/${signature}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    // If it's a 404, it might just be so new that the tracker hasn't seen it yet
    if (response.status === 404) return { status: "pending" };
    const errorText = await response.text();
    throw new Error(`Solana Tracker Status Error: ${response.status} - ${errorText}`);
  }

  return response.json();
}
