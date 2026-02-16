# Top 5 Specialized Agents for Solution Architect & PM

**User Profile**:
- **Role**: Solution Architect & Project Manager
- **Domain**: AWS Cloud Infrastructure, DevOps, Software Engineering
- **Client**: Singapore Government Agencies
- **Philosophy**: TDD enthusiast, systematic approach, highly maintainable code

## Agent Selection Rationale

Based on the user's role working with government agencies on AWS cloud infrastructure, these 5 agents address the highest-value, most cognitively demanding tasks:

---

## 1. AWS Cloud Architect Agent

### Purpose
Infrastructure design, architecture decisions, cost optimization, AWS service selection

### Why Critical
- Government agencies need cost-effective, compliant AWS solutions
- Architecture decisions have long-term impact on maintenance and costs
- Specialized knowledge of AWS best practices and gov compliance requirements

### Key Capabilities
- Design scalable, secure AWS architectures
- Cost optimization analysis and recommendations
- Service selection trade-offs (RDS vs DynamoDB, Lambda vs ECS, etc.)
- CDK/CloudFormation review
- Well-Architected Framework compliance

### Example Use Cases
- "Design a secure S3 + CloudFront architecture for public file distribution"
- "Optimize our Lambda costs - we're spending $500/month on infrequent functions"
- "Review this CDK stack for best practices and security issues"
- "Choose between API Gateway REST vs HTTP APIs for this use case"

### Claude Code Agent Mapping
- Primary: `architect.md` - System architecture design
- Secondary: `database.md` - Database architecture decisions
- Tools: AWS CLI, CDK synthesis, cost calculators

---

## 2. Security & Compliance Analyst Agent

### Purpose
Security audits, compliance checks (PDPA, gov standards), vulnerability assessment, IAM policy review

### Why Critical
- Government sector has strict security and compliance requirements
- Singapore PDPA compliance is mandatory
- Security vulnerabilities can have severe consequences for gov projects

### Key Capabilities
- Security code review and vulnerability scanning
- PDPA compliance validation
- IAM policy analysis and least-privilege verification
- Threat modeling for new features
- Security architecture review

### Example Use Cases
- "Audit this API endpoint for security vulnerabilities"
- "Is this data handling PDPA-compliant?"
- "Review these IAM policies - are we following least privilege?"
- "Security implications of exposing this internal service publicly?"
- "Threat model for this citizen-facing authentication flow"

### Claude Code Agent Mapping
- Primary: `security.md` - Security specialist
- Secondary: `reviewer.md` - Code review with security focus
- Tools: Security scanners, AWS IAM policy simulator

---

## 3. Technical Documentation Specialist Agent

### Purpose
Architecture Decision Records (ADRs), system design documents, runbooks, stakeholder reports, documentation generation

### Why Critical
- Government projects require extensive documentation for audit trails
- Stakeholder communication needs clarity and professionalism
- Documentation enables knowledge transfer and onboarding

### Key Capabilities
- Generate formal ADRs with context, decision, consequences
- Create system design documents from code/architecture
- Write executive summaries for non-technical stakeholders
- Generate runbooks and operational guides
- Transform technical decisions into clear business language

### Example Use Cases
- "Document this architecture decision to use DynamoDB over RDS"
- "Create a runbook for deploying this Lambda function"
- "Write an executive summary of this sprint's work for the ministry"
- "Generate API documentation from this OpenAPI spec"
- "Create onboarding docs for new developers on this project"

### Claude Code Agent Mapping
- Primary: `documentation-writer.md` - Documentation specialist
- Secondary: `visualization-architect.md` - Diagrams and visual docs
- Tools: Mermaid diagrams, ADR templates, doc generators

---

## 4. Code Quality & TDD Coach Agent

### Purpose
Code review, test coverage analysis, refactoring suggestions, TDD workflow guidance

### Why Critical
- User is a TDD enthusiast - needs to maintain high standards
- Government projects have long lifecycles - maintainability is paramount
- Technical debt accumulates quickly without disciplined review

### Key Capabilities
- Comprehensive code review with philosophy compliance
- Test gap analysis and test case suggestions
- Refactoring recommendations for maintainability
- TDD workflow guidance (red-green-refactor)
- Pattern recognition and anti-pattern detection

### Example Use Cases
- "Review this PR for code quality and test coverage"
- "Suggest test cases for this authentication function"
- "Is this code maintainable? How can I simplify it?"
- "Refactor this 200-line function into smaller, testable units"
- "What's missing from our test suite for this feature?"

### Claude Code Agent Mapping
- Primary: `reviewer.md` - Code review specialist
- Secondary: `tester.md` - Test generation and coverage
- Tertiary: `optimizer.md` - Performance and quality optimization
- Tools: Test runners, coverage tools, linters

---

## 5. Project Orchestrator / General Assistant Agent

### Purpose
Task delegation, meeting notes, quick questions, general assistance, project coordination

### Why Critical
- As a PM, needs to coordinate work and track tasks across teams
- Many queries don't fit into specialized categories
- Quick turnaround needed for misc questions and coordination

### Key Capabilities
- Meeting note summarization and action item extraction
- Task creation and breakdown from requirements
- General Q&A on any topic
- Delegation and workstream coordination
- Context switching and triage to specialized agents

### Example Use Cases
- "Summarize this meeting transcript and extract action items"
- "Break down this feature request into implementable tasks"
- "Quick question: what's the difference between EC2 and Fargate?"
- "Draft an email to the client explaining this delay"
- "Create a project plan for this 3-month infrastructure migration"

### Claude Code Agent Mapping
- Primary: `general-purpose` - No specialization, broad capabilities
- Secondary: `prompt-writer.md` - Requirement clarification
- Tertiary: `work-delegator.md` - Task breakdown and delegation
- Tools: All general tools, no specific specialization

---

## Summary Matrix

| Agent | Primary Focus | Telegram Topic | Claude Code Agent | Frequency |
|-------|--------------|----------------|-------------------|-----------|
| AWS Cloud Architect | Infrastructure design | "AWS Architect" | architect.md | High |
| Security & Compliance | Security audits | "Security" | security.md | Medium |
| Documentation | ADRs, reports, docs | "Documentation" | documentation-writer.md | Medium |
| Code Quality & TDD | Code review, testing | "Code Quality" | reviewer.md, tester.md | High |
| General / Orchestrator | Everything else | "General" | general-purpose | High |

## Prioritization

**Must Have (MVP)**:
1. AWS Cloud Architect - Highest value for infrastructure decisions
2. General / Orchestrator - Catch-all for everything else

**Should Have**:
3. Security & Compliance - Critical for gov sector
4. Code Quality & TDD - Aligns with user's philosophy

**Nice to Have**:
5. Documentation - Can start manually, automate later

This allows phased rollout starting with 2 agents, expanding to 5 as adoption grows.
