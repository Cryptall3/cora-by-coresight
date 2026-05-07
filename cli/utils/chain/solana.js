/**
 * Solana transaction building, signing (via OWS), and RPC broadcast.
 */

import {
  Connection,
  sendAndConfirmRawTransaction,
} from "@solana/web3.js";
import { getSolanaRpcUrl } from "./registry.js";
import * as ows from "../wallet/keystore.js";
import * as solanaTracker from "../api/solana-tracker.js";


let _connection;
function getConnection() {
  if (!_connection) {
    _connection = new Connection(getSolanaRpcUrl(), "confirmed");
  }
  return _connection;
}

/**
 * Sign and broadcast a Solana transaction from the Zerion swap API.
 *
 * The Zerion API returns transaction data as a hex-encoded serialized
 * Solana transaction. We deserialize it, sign with OWS, and broadcast.
 */
export async function signAndBroadcastSolana(swapTxData, walletName, passphrase) {
  const connection = getConnection();

  // The v1 Quotes API returns Solana tx as base64 in the 'raw' field.
  // The legacy Offers API returns it as hex in the 'data' field.
  const rawBase64 = swapTxData.raw;
  let txData = swapTxData.data;

  if (rawBase64) {
    txData = Buffer.from(rawBase64, 'base64').toString('hex');
  }

  if (!txData) {
    throw new Error("No transaction data from swap API for Solana");
  }

  let signedTxBytes;

  try {
    // Sign with OWS — pass the raw tx bytes as hex for OWS to sign
    const signResult = ows.signSolanaTransaction(walletName, txData, passphrase);

    const signatureBytes = Buffer.from(signResult.signature, "hex");

    if (rawBase64) {
      // The v1 Quotes API returns a serialized transaction with dummy signature bytes
      // The first byte is the number of signatures, the next 64 bytes are the fee payer's signature
      const txBuf = Buffer.from(rawBase64, 'base64');
      signatureBytes.copy(txBuf, 1);
      signedTxBytes = txBuf;
    } else {
      // Legacy handling
      signedTxBytes = signatureBytes;
    }
  } catch (err) {
    throw new Error(`Failed to sign Solana transaction: ${err.message}`);
  }

  // Broadcast
  const txHash = await sendAndConfirmRawTransaction(connection, signedTxBytes, {
    skipPreflight: false,
    commitment: "confirmed",
  });

  return {
    hash: txHash,
    status: "success",
    chain: "solana",
  };
}

/**
 * Sign and send a Solana Tracker (Raptor) transaction.
 * Uses high-speed Jet TPU for broadcasting.
 */
export async function signAndSendRaptorTransaction(swapTxBase64, walletName, passphrase) {
  let signedTxBytes;

  try {
    // 1. Prepare raw bytes
    const txBuf = Buffer.from(swapTxBase64, "base64");
    const txHex = txBuf.toString("hex");

    // 2. Sign with OWS
    const signResult = ows.signSolanaTransaction(walletName, txHex, passphrase);
    const signatureBytes = Buffer.from(signResult.signature, "hex");

    // 3. Inject signature at index 1 (standard for fee payer in serialized Solana tx)
    signatureBytes.copy(txBuf, 1);
    signedTxBytes = txBuf;
  } catch (err) {
    throw new Error(`Failed to sign Raptor transaction: ${err.message}`);
  }

  // 4. Send via high-speed Jet TPU
  const sendResult = await solanaTracker.sendTransaction(signedTxBytes.toString("base64"));

  if (!sendResult.success) {
    throw new Error(`Raptor Send Failed: ${sendResult.error || "Unknown Error"}`);
  }

  return {
    hash: sendResult.signature,
    status: "pending",
    chain: "solana",
  };
}
