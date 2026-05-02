# Cora Autonomous Agent: Engineering Log (May 1, 2026)

This document serves as the technical summary of the foundation built for the Cora Autonomous Trading Agent.

## 1. Core Architecture & Infrastructure
- **Database Isolation**: Isolated agent data into a dedicated `cora-bot` database while maintaining a secure cross-database link to the main `coresight-bot` database for subscription validation.
- **Multi-Wallet Hub**: Implemented a professional wallet management system allowing users to create, rename, and delete multiple accounts. 
- **Encryption Standards**: All wallet seed phrases are stored using **AES-256-CBC** encryption, using the `ZERION_API_KEY` as the master derivation key. Plain-text keys never touch the database.

## 2. Secure Execution Engine (Agent Tokens)
- **Zero-Trust Signing**: Implemented **Agent Tokens** (OWS API Keys). When a user activates the sniper, Cora generates a unique, revocable token for that session.
- **Unattended Trading**: Cora can sign and execute trades 24/7 using these tokens without requiring the user's passphrase to be stored in the cloud.
- **Revocability**: Users can stop Cora's access instantly by toggling the Sniper off, which invalidates the session permissions.

## 3. Alpha Sniper System
- **Real-Time Listener**: Built a persistent `AlphaListener` that monitors the `alpha_tokens` collection in the Coresight database.
- **High-Speed Detection**: Utilizes **MongoDB Change Streams** for millisecond-latency detection, with an automatic polling fallback for environment stability.
- **Parallel Execution**: Engineered to handle high concurrency. When a signal drops, Cora executes trades for all active users simultaneously using asynchronous parallel promises.
- **Trade Recording**: Every execution is logged in a `trades` collection, capturing entry price, amount, and transaction hashes for future PnL dashboards.

## 4. Tactics & UX Engine
- **Custom Parameters**: Added interactive prompts allowing users to set precise values for:
    - Default Buy Amount (SOL)
    - Take Profit % (TP)
    - Stop Loss % (SL)
    - Max Slippage %
- **Tactics UI**: Created a "Command Briefing" screen that shows the user exactly what metrics will be used before they confirm the sniper activation.
- **Logging & Diagnostics**: Integrated `[BOT]` console logging for all button interactions to ensure real-time visibility into user behavior and system health.

## 5. Technical Context for Future Development
- **Database Names**: 
    - `cora-bot`: User profiles, settings, and trade records.
    - `coresight-bot`: Subscription data and Alpha signals.
- **Key Services**:
    - `UserService`: Wallet CRUD and encryption.
    - `AlphaListener`: Signal detection.
    - `TradeExecutor`: Zerion-powered swap logic.
- **Dependencies**: Telegraf (Bot), @solana/web3.js, @open-wallet-standard/core (OWS).

---
**Status**: Alpha Sniper is LIVE.
**Next Priority**: Auto-Exit Logic (Background price monitoring) and PnL Dashboard.
