# Delo Protocol
### Decentralized reputation, owned by you.

---

## The Idea

Every time you work with someone — a freelancer delivers a project, a company pays a contractor, a buyer receives goods — an economic interaction takes place. That interaction says something about you: how reliable, honest, and professional you are.

The history is yours, but in today's world you don't own it.

It lives on the servers of Upwork, Fiverr, Amazon, LinkedIn — and when a platform changes its rules, raises its fees, or starts acting in ways that make you want to leave, you face a choice: stay and put up with it, or walk away and hand over everything you've built. Years of work, hundreds of deals, your reputation — all of it was rented, never owned.

**Delo Protocol gives reputation back to its owner.**

---

## What It Is

Delo Protocol is a decentralized economic reputation system. Users make deals directly with each other, record the outcomes, and build a history of interactions that:

- **is stored locally** on the user's device
- **depends on no server** and cannot be deleted or blocked
- **is visible to anyone** in the network
- **belongs only to you** — and goes wherever you go

Users can be individuals or companies.

> Delo Protocol is a trust layer for people doing business with each other.

---

## How It Works

### Identity

On first launch, the app generates a cryptographic key pair. Your public key is your identity on the network. No email, no password, no SMS verification. Key = identity.

### Deals

Two parties make a deal and record it in the protocol. Each deal contains: the parties, amount, terms, and outcome. Once confirmed by both sides, the record is written to an **immutable append-only log** — a deal history that cannot be edited or deleted after the fact.

### Reputation

Based on the deal history, the system calculates a **trust volume** — an economic reputation score. It reflects the total volume of completed deals weighted by their outcomes: positive, neutral, and negative. Anyone on the network can view a participant's reputation — all you need is their contact key.

---

## Deal Types

### Review *(implemented)*
A deal with negotiated terms. The initiator describes their terms, the counterparty responds with theirs, the initiator confirms — and only then does the deal move into progress. Each party closes the deal independently with a rating and an optional comment. Builds the fullest picture for anyone reviewing your reputation.

### Handshake *(coming soon)*
A quick record of a completed deal with no term negotiation. Suitable for cases where the deal has already happened and both parties simply want to log it.

### Escrow *(coming soon)*
A deal with funds locked via smart contract. Money is held for the duration of the obligation and automatically released upon confirmation of completion. Maximum level of trust.

---

## Principles

**No servers.** Interaction happens directly between participants over a P2P protocol. No central node means no single point of failure, censorship, or manipulation.

**No paywalled features.** Your reputation doesn't depend on a subscription. No one can boost your ranking for money or penalize you for violating a platform's commercial interests.

**No vendor lock-in.** Your deal history is stored in an append-only log on your own device. You can leave at any time — and take your reputation with you.

**Immutability.** Log entries cannot be edited after the fact. Reputation is built on facts.

**Multi-currency.** Deal amounts are recorded in the original currency and stored with equivalents at the time of the deal — USD, RUB, EUR, BTC, USDT. Reputation is displayed in the viewer's preferred currency.

---

## Technology

Delo Protocol is built on **[Pear Runtime](https://pears.com)** (Holepunch) — a P2P platform using the Hypercore Protocol for decentralized data storage and synchronization.

- **Hypercore** — append-only deal history log. Cryptographically verified and replicable between peers.
- **Hyperdrive** — stores user profile and active deals.
- **Hyperswarm** — P2P peer discovery via DHT with no central server.
- **Rust → WASM** — reputation calculation runs locally in a WASM module written in Rust.

---

## Status

The project is in active development. MVP is complete:

- [x] Identity generation (ed25519 keypair)
- [x] User profile with avatar (Hyperdrive)
- [x] P2P peer discovery and profile viewing
- [x] Contacts
- [x] Review deal — full negotiation and close cycle
- [x] Transport layer with retry logic and offline delivery
- [x] Deal history with expiry mechanism
- [x] Reputation calculation (WASM, Rust)
- [x] View any participant's reputation by contact key
- [x] Multi-currency support
- [ ] Handshake deal
- [ ] Escrow (smart contract)
- [ ] Deal rating criteria (quality, timing, communication)
- [ ] Anti-sybil analysis and trust graph

---

## Contributing

The project is open to contributors. If the idea of decentralized reputation resonates with you — check the open issues or reach out directly.

Stack: **Rust**, **JavaScript (Bare/Node-like)**, **Svelte 5**, **Pear Runtime**.

---

*Delo Protocol is open source. No company owns it. No server controls it.*
