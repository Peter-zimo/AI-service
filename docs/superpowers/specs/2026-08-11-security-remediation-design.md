# Enterprise Demo Security Remediation Design

## Goal

Close all P0, P1, and P2 findings from the 2026-08-11 audit while preserving the public Node visitor flow.

## Security boundaries

The Node service is the only browser-facing API. The Python service is internal: it binds to loopback by default, is not host-published by Compose, and requires `AI_SERVICE_TOKEN` on every non-health request. Node supplies that token in a request header.

Visitor data is authorized by a conversation capability: APIs that read personal orders require both `conversationId` and the owning `visitorId`. The phone is stored on the conversation only after an explicit user-provided lookup and is never accepted as a standalone authorization factor. Agent APIs additionally require that the requesting agent owns the assigned conversation; administrators retain read access.

## Data consistency

Conversation lifecycle methods always await their database reads. Python retrieval obtains its knowledge through a protected Node internal endpoint when Node is configured for PostgreSQL; SQLite remains the local-development fallback. Knowledge reload is restricted to the same internal authorization boundary.

## Reliability and deployment

Login and high-cost internal endpoints are rate limited. Python validates request lengths and uses a local keyword safety fallback when an LLM moderation call cannot run. Production Compose receives no default database password, does not publish PostgreSQL or Python ports, and documents required secrets and allowed origins. Dependency versions are updated where the registry provides a safe release; unavoidable upstream advisories are documented.

## Verification

Each boundary has a focused regression test: service-token rejection, visitor and agent ownership, conversation lifecycle state transitions, and deployment/config validation. Existing Node and Python suites run after every task and again at the end. No live model call is used in verification.
