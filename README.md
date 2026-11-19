# Janesis Core

**A modular backend platform engineered for reliability, scalability, and continuous evolution.**

[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Runtime-Node.js-green?logo=nodedotjs)](https://nodejs.org/)

## Overview

Janesis Core is an established backend platform built to support reliable service delivery, modular system evolution, and sustained operational growth. Its engineering approach combines strict architectural boundaries, deterministic configuration, continuous quality gates, and controlled dependency management to establish a foundation for resilient, scalable backend services.

Designed around separation of concerns and explicit component contracts, Janesis Core enables capabilities to evolve while maintaining wider system integrity. Technical implementation prioritizes operational resilience, predictable runtime behavior, security-conscious design, and long-term maintainability. The platform is packaged as a container and runs on Google Cloud Run.

---

## System Architecture

Janesis Core adopts a modular, layered architecture informed by Clean Architecture and Hexagonal Architecture principles. Each layer has a defined responsibility, with explicit boundaries governing interactions between application logic, transport mechanisms, and infrastructure implementations.

| Layer / Component           | Responsibility                                                                                       |
| :-------------------------- | :--------------------------------------------------------------------------------------------------- |
| **Transport Layer**         | Handles incoming transport protocols, routing, and service interfaces.                               |
| **Application Layer**       | Coordinates application workflows and use-case interactions.                                         |
| **Domain Layer**            | Encapsulates core domain business rules and preserves domain independence from technical frameworks. |
| **Infrastructure Ports**    | Define explicit contracts for technical capabilities required by the application layer.              |
| **Infrastructure Adapters** | Encapsulate technical implementations behind established contracts.                                  |
| **Bootstrap Layer**         | Composes application components and manages runtime dependency injection.                            |
| **Configuration Layer**     | Centralizes environment configuration and validates required settings at startup.                    |

This architecture establishes a foundation for independent testing, controlled change, and incremental expansion while minimizing coupling between core domain logic and external infrastructure concerns.

---

## Structural Mapping

The architectural layers are organized into a predictable directory structure that separates transport, application, domain, configuration, and infrastructure responsibilities.

```text
src/
├── config/             # Configuration Layer (Zod environment schemas)
├── bootstrap/          # Bootstrap Layer (Dependency injection composition)
├── transport/          # Transport Layer (Fastify routes and HTTP controllers)
└── core/
    ├── domain/         # Domain Layer (Domain entities and logic)
    ├── application/    # Application Layer (Use-case coordinators)
    └── infrastructure/
        ├── ports/      # Structural contracts (TypeScript interfaces)
        └── adapters/   # Concrete technical implementations
```

---

## Technology Stack

The stack is selected to support strict type safety, modular development, runtime validation, and maintainable backend execution.

| Area                            | Technology                 |
| ------------------------------- | -------------------------- |
| **Programming Language**        | TypeScript                 |
| **Runtime Environment**         | Node.js                    |
| **Backend Framework**           | Fastify                    |
| **Schema Validation**           | Zod                        |
| **Testing Engine**              | Native Node.js test runner |
| **Code Quality and Formatting** | ESLint and Prettier        |
| **Static Security Analysis**    | Semgrep Community Edition  |
| **Containerization**            | Docker                     |
| **Cloud Platform**              | Google Cloud Platform      |
| **Hosting Runtime**             | Google Cloud Run           |
| **CI/CD Automation**            | GitHub Actions             |

---

## Reliability and Operations

Operational resilience is a core engineering priority. Janesis Core is designed around predictable startup behavior, explicit configuration contracts, controlled application lifecycles, and diagnosable runtime failures.

- **Deterministic Configuration:** Runtime configuration is validated against explicit schemas using Zod to prevent invalid settings from silently entering the application context.
- **Lifecycle Management:** Application startup and shutdown are structured around controlled resource management and graceful handling of termination signals.
- **Health and Readiness:** Health interfaces support runtime monitoring and orchestration readiness checks.
- **Security-Conscious Diagnostics:** Configuration failures provide actionable diagnostic information without unnecessarily exposing sensitive credential values.
- **Operational Stabilization:** Engineering efforts prioritize runtime consistency, configuration integrity, and service reliability.

---

## Cloud and Infrastructure

Janesis Core runs as a containerized service on Google Cloud Run, Google Cloud Platform's fully managed serverless container runtime. The service is built to the operating contract of that platform, and the contract is verified in CI on every change rather than assumed.

| Cloud Run Characteristic            | How Janesis Core Aligns                                                                                                                               |
| :---------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Container-based deployment**      | The service is packaged as a Docker image that CI builds and smoke-tests on every change.                                                             |
| **Managed, elastic scaling**        | The service is designed to be stateless, so instances can be added and removed freely as demand changes.                                              |
| **Environment-based configuration** | Configuration is supplied through environment variables and validated against Zod schemas at startup.                                                 |
| **Revision safety**                 | Invalid or missing configuration makes the container exit immediately with a non-zero code, so a misconfigured revision cannot start serving traffic. |
| **Health signalling**               | Dedicated liveness and readiness endpoints expose service state for platform health checks.                                                           |
| **Graceful termination**            | The service handles termination signals and exits cleanly within the platform's shutdown window.                                                      |
| **HTTP serving**                    | The container serves HTTP on port 8080, the Cloud Run default container port.                                                                         |
| **Least-privilege runtime**         | The container runs as a non-root user.                                                                                                                |

### Container Contract Verified in CI

The `docker` job in the CI pipeline exercises the same behaviors Cloud Run depends on, using the exact image that is built from the repository:

- The image runs the same Node.js version pinned in `package.json`.
- The container process runs as a non-root user.
- The container fails fast with an invalid-configuration error when required configuration is absent.
- The liveness endpoint answers HTTP 200 on port 8080, and the readiness endpoint answers HTTP 200.
- The container stops within a 10-second grace period, exits with code 0, and logs that shutdown started, matching the termination window Cloud Run allows.

### Delivery Boundary

CI produces a verified container image and a single pass or fail status. Deployment to Google Cloud Run is a separate concern from verification, and rollout is managed independently of the CI workflow.

---

## Continuous Integration and Delivery

Automated verification is central to the development lifecycle. The CI workflow is a nine-job pipeline in which eight independent verification jobs each own a single concern, and a ninth job, `ci-ok`, consolidates their outcomes into one status. The verification jobs have no ordering dependencies between them, so they run in parallel and report separately.

### Triggers and Execution Controls

| Control                | Behavior                                                                                                                                 |
| :--------------------- | :--------------------------------------------------------------------------------------------------------------------------------------- |
| **Triggers**           | Runs on every pull request, on pushes to `main`, and on manual dispatch.                                                                 |
| **Permissions**        | Workflow permissions are limited to read-only repository contents.                                                                       |
| **Concurrency**        | Runs are grouped per workflow and ref; superseded pull request runs are cancelled automatically.                                         |
| **Credential Hygiene** | Checkout steps do not persist repository credentials in the runner.                                                                      |
| **Timeouts**           | Every job has an explicit timeout to prevent stalled runs from consuming resources.                                                      |
| **Runner**             | Jobs execute on a pinned Ubuntu runner image with a consistent Bash shell for repeatable environments.                                   |
| **Node.js Version**    | Node.js jobs resolve the runtime version from `package.json`, so CI and local development share a single pinned version.                 |
| **Gate Reporting**     | Each job runs its gates independently, publishes a per-gate summary, and fails at the end if any gate failed (see Gate Reporting below). |

### Pipeline Jobs

| Pipeline Job          | Objective                                                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `secrets-scan`        | Scans the full git history for accidentally exposed secrets, hardcoded keys, and credentials.                                                                  |
| `dependency-security` | Enforces a committed lockfile and audits dependencies for high-severity vulnerabilities and above.                                                             |
| `sast`                | Runs static application security analysis on source and scripts with Semgrep Community Edition.                                                                |
| `code-quality`        | Runs formatting, linting with boundary rules, type-checking, and a production build from a lockfile-exact install.                                             |
| `unit-tests`          | Runs unit tests with coverage reporting, with no database configured.                                                                                          |
| `integration-tests`   | Runs database-backed integration tests against a disposable database service, and verifies that every declared test actually executed.                         |
| `architecture-tests`  | Runs the architecture test suite that guards layer boundaries and structural constraints.                                                                      |
| `docker`              | Builds the container image and validates its runtime behavior: Node version, non-root user, fail-fast configuration, health, readiness, and graceful shutdown. |
| `ci-ok`               | Consolidates the eight verification outcomes into a single integration status.                                                                                 |

### Job Details

**`secrets-scan`**

- Installs a pinned gitleaks release and verifies its SHA-256 checksum before execution.
- Scans the complete git history (full-depth checkout) rather than only the latest changes.
- Redacts findings in all output and fails the job on any detection.
- Uploads a redacted SARIF report as a workflow artifact when the scan fails.
- Fails if the scanner cannot be installed or verified, so an unverified scan never passes silently.

**`dependency-security`**

- Fails if `package-lock.json` is not committed; the lockfile is the resolution authority and CI never regenerates it.
- Runs `npm audit` at the high severity threshold and reports vulnerability counts by severity.
- Checks known advisories for locked versions only; licenses and package provenance are outside its scope.

**`sast`**

- Runs Semgrep Community Edition from a version-pinned container image using the default rule set.
- Scans `src` and `scripts`, with telemetry and metrics reporting disabled.
- Fails the job on any finding.
- Does not perform cross-file taint analysis, commercial rules, or runtime testing.

**`code-quality`**

- Requires a committed lockfile and installs dependencies exactly as locked with `npm ci`.
- Runs the non-mutating Prettier formatting check, ESLint including dependency-boundary rules, the TypeScript type-check across source and tests, and the production build.
- Reports whether the runner's Node.js version matches the pinned version, along with the size of the build output.

**`unit-tests`**

- Deliberately runs with no database service and verifies that no database connection variables are set.
- Excludes the architecture suite and any test whose name begins with `INTEGRATION:`, which run in their own jobs.
- Runs on the native Node.js test runner with coverage reporting and surfaces todo stubs explicitly, since they verify nothing yet.
- Fails if no unit test files are selected.

**`integration-tests`**

- Provisions a disposable PostgreSQL service container with throwaway, CI-only credentials and waits for it to be healthy before testing.
- Discovers tests whose names begin with `INTEGRATION:` and fails if none are found.
- Compares executed tests against declared tests and fails unless every declared test ran and passed, with zero failures and zero skips.
- Reports coverage for the integration tests alone.
- Does not exercise third-party managed services; the database here is a local disposable instance.

**`architecture-tests`**

- Runs every test under `tests/architecture` and fails if none are found.
- Guards established structural constraints; it does not replace architectural review or approval.

**`docker`**

- Builds the container image and reports its size.
- **Runtime version:** Confirms the image runs the same Node.js version pinned in `package.json`.
- **Non-root:** Confirms the container process does not run as root.
- **Fail-fast configuration:** Confirms the container exits with code 1 and an invalid-configuration message when required environment configuration is missing.
- **Liveness:** Starts the container with valid configuration and polls the health endpoint for up to 30 seconds, expecting HTTP 200, printing container logs if it never answers.
- **Readiness:** Requests the readiness endpoint and requires HTTP 200.
- **Graceful shutdown:** Stops the container with a 10-second grace period, then requires a zero exit code and a logged shutdown-started message, validating termination signal handling against the Cloud Run termination window.
- Always removes the smoke-test container, even when earlier steps fail.
- Does not cover behavior under load or the production hosting environment.

**`ci-ok`**

- Runs regardless of upstream outcomes and depends on all eight verification jobs.
- Validates that exactly the eight expected prerequisite results are present, so a renamed, removed, or missing job fails the gate instead of being ignored.
- Requires every prerequisite to have succeeded; failed, cancelled, and skipped jobs all fail the gate.
- Publishes a consolidated result table and serves as the single status check for branch protection.

### Gate Reporting

Every verification job follows the same reporting pattern. Gates within a job run independently, so one failure does not hide the results of later gates. Each job publishes a summary table in the workflow run marking every gate as `VERIFIED`, `FAILED`, or `NOT VERIFIED`, includes the commit and branch under test, and lists what the job explicitly does not verify. The job then fails if any gate failed.

### Supply Chain Hardening

Third-party action references currently use version tags. Pinning them to reviewed commit SHAs is planned before the workflow is enforced as a required check.

The workflow supports repeatable verification, early defect detection, and regression control. CI verification and production deployment are distinct concerns, with deployment and rollout processes managed separately.

---

## Verification and Quality Assurance

Quality assurance is integrated into the Janesis Core development lifecycle, with automated checks covering code quality, type safety, test coverage, build integrity, static security analysis, container behavior, and dependency security. These controls promote consistent engineering standards, support regression prevention, and strengthen the reliability of every change.

| Quality Gate             | Verification Tooling                                     |
| :----------------------- | :------------------------------------------------------- |
| **Code Formatting**      | Prettier                                                 |
| **Static Analysis**      | ESLint                                                   |
| **Type Safety**          | TypeScript compiler                                      |
| **Unit Testing**         | Native Node.js test runner and coverage tooling          |
| **Integration Testing**  | Native Node.js test runner against a disposable database |
| **Architecture Testing** | Dedicated architecture test suite                        |
| **Build Validation**     | Project build pipeline                                   |
| **Security Analysis**    | Semgrep Community Edition                                |
| **Secret Detection**     | Gitleaks, full git history                               |
| **Dependency Security**  | Automated dependency audit                               |
| **Container Validation** | Docker build and runtime smoke tests                     |

Quality controls support repeatable verification, early defect detection, and consistent engineering standards throughout development.

---

## Security-Conscious Engineering

Security is addressed through explicit boundary validation, controlled dependencies, careful diagnostic design, and automated security checks.

Janesis Core prioritizes:

- Validation of runtime configuration against defined schemas.
- Decoupled interactions between architectural layers.
- Careful handling of sensitive values in diagnostic output.
- Automated, full-history checks for accidental secret exposure, with redacted reporting.
- Static application security analysis of source and scripts on every change.
- Checksum-verified, version-pinned security tooling in CI.
- Least-privilege CI permissions and non-persisted checkout credentials.
- Non-root container execution and fail-fast behavior on invalid configuration, verified on every build.
- Dependency auditing, enforced lockfiles, and consistent build practices.

This documentation presents the platform's architecture and engineering approach without disclosing proprietary business logic, private protocol details, sensitive operational credentials, or vendor-specific integrations beyond the hosting platform.

---

## Engineering Principles

1. **Reliability by Design** — Prioritize predictable startup, controlled lifecycles, and diagnosable failures.
2. **Architectural Modularity** — Maintain explicit layers, clear responsibilities, and controlled dependency graphs.
3. **Security-Conscious Engineering** — Apply defensive configuration validation, careful logging, and credential scanning.
4. **Sustainable Scalability** — Support incremental capability growth while minimizing unnecessary architectural coupling.
5. **Automated Verifiability** — Use repeatable quality gates to identify regressions and maintain engineering standards.
6. **Continuous Evolution** — Strengthen the platform through iterative engineering, verification, and architectural review.

---

## Set up Requirements

**Requirements:** Node.js 22 or later and npm.

### Setup

Install dependencies:

```bash
npm ci
```

### Scripts

| **Script**              | **Purpose**                                                    |
| ----------------------- | -------------------------------------------------------------- |
| `npm run format:check`  | Prettier formatting check                                      |
| `npm run lint`          | ESLint, including dependency-boundary rules                    |
| `npm run typecheck`     | Type-check source and tests                                    |
| `npm test`              | Unit and architecture tests using `node:test`                  |
| `npm run test:coverage` | Run tests with coverage reporting                              |
| `npm run build`         | Compile TypeScript to `dist/`                                  |
| `npm run audit:deps`    | Audit dependencies for high-severity vulnerabilities and above |
