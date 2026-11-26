# Hydra specification library

This directory is the design baseline Hydra is built from. It states what the product is for, which rules it must obey, how its data is shaped, and which seams an implementer is not free to invent around.

The [operator manual](../README.md) tells a person how to install and use a running console. [AGENTS.md](../AGENTS.md) is the working agreement for anyone changing the repository. This library is the source those two documents describe for their own audiences. A change to behaviour starts here, then in the implementation, then in the operator manual when an operator would notice.

Normative words:

- **Shall** is mandatory.
- **Decision** is a settled choice. Reopening it means updating the decision in the same change as the code.
- Identifiers (`BR-01`, `INV-04`, `ADR-02`, `NFR-06`) are stable. Do not reuse a retired number.

## Who reads what

| Reader | Start | Then |
|---|---|---|
| Product owner | [Vision and scope](product/vision-and-scope.md) | [Journeys](product/journeys.md), the outcome rules in the [execution model](architecture/execution-model.md) |
| Business analyst | [Business requirements](product/business-requirements.md) | [Domain model](domain/domain-model.md), [journeys](product/journeys.md) |
| Solution architect | [Solution architecture](architecture/solution-architecture.md) | [Security and tenancy](architecture/security-and-tenancy.md), [execution model](architecture/execution-model.md), [service contracts](interfaces/service-contracts.md) |
| Developer | [Construction standards](engineering/construction-standards.md) | [Domain model](domain/domain-model.md), [service contracts](interfaces/service-contracts.md), [data design](data/data-design.md) |
| Database administrator | [Data design](data/data-design.md) | [Security and tenancy](architecture/security-and-tenancy.md), identity and retention sections |

## Map

| Document | Question it answers |
|---|---|
| [product/vision-and-scope.md](product/vision-and-scope.md) | Why this product exists, who it is for, what it refuses to become, and the order capabilities depend on each other. |
| [product/business-requirements.md](product/business-requirements.md) | The capabilities, business rules, and acceptance tests the product shall meet. |
| [product/journeys.md](product/journeys.md) | End-to-end operator journeys, including the unhappy paths that must still be designed. |
| [domain/domain-model.md](domain/domain-model.md) | The language, aggregates, lifecycles, and invariants every other document uses. |
| [architecture/solution-architecture.md](architecture/solution-architecture.md) | Containers, trust boundaries, and the architecture decisions. |
| [architecture/security-and-tenancy.md](architecture/security-and-tenancy.md) | Accounts, sessions, secrets, agent isolation, and the limits of that isolation. |
| [architecture/execution-model.md](architecture/execution-model.md) | How a run, a pipeline, a gate, and a supervised allowance are required to behave. |
| [data/data-design.md](data/data-design.md) | Where state lives, the logical and physical model, migrations, retention, backup, and restore. |
| [engineering/construction-standards.md](engineering/construction-standards.md) | Where code goes, how a provider, a setting, or a migration is added, and what must not be done to a live console. |
| [interfaces/service-contracts.md](interfaces/service-contracts.md) | The HTTP resources, the WebSocket protocol, normalised events, and the `agent-step` callback. |

## How the documents stay honest

A specification states the obligation. It does not narrate a finished screen or name a file as proof that the obligation is already met. File paths appear only where the construction standard prescribes a home for an obligation, so two implementers do not invent two homes.

When this library and the operator manual disagree about operator-visible behaviour, the operator manual is stale. When this library and the code disagree, either the code has drifted or the specification was never updated for a real decision. Fix the drift in the same change. Do not leave a second, quieter source of truth in a comment.
