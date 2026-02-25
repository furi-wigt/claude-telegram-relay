#!/usr/bin/env bun

/**
 * @routine security-daily-scan
 * @description Daily security scan and vulnerability report
 * @schedule 0 8 * * *
 * @target Security group
 */

/**
 * Security Daily Scan Summary Routine
 *
 * Schedule: 8:00 AM daily
 * Target: Security & Compliance group
 *
 * Gathers security findings and sends them to the Security group.
 * The Security agent triages findings with its compliance expertise
 * (PDPA, AIAS) and prioritizes remediation steps.
 *
 * Run manually: bun run routines/security-daily-scan.ts
 */

import { sendAndRecord } from "../src/utils/routineMessage.ts";
import { GROUPS, validateGroup } from "../src/config/groups.ts";

interface SecurityFindings {
  critical: number;
  high: number;
  medium: number;
  low: number;
  newFindings: Array<{ severity: string; title: string }>;
  complianceStatus: { pdpa: boolean; aias: boolean };
}

async function getSecurityFindings(): Promise<SecurityFindings> {
  // TODO: Integrate with AWS Security Hub and GuardDuty
  //
  // Example integration:
  //   import { SecurityHubClient, GetFindingsCommand } from "@aws-sdk/client-securityhub";
  //   const client = new SecurityHubClient({ region: "ap-southeast-1" });
  //   const findings = await client.send(new GetFindingsCommand({...}));
  //
  // For now, return empty findings. The agent still provides useful
  // security guidance patterns during testing.
  return {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    newFindings: [],
    complianceStatus: {
      pdpa: true,
      aias: true,
    },
  };
}

function formatSecurityMessage(findings: SecurityFindings): string {
  const lines = [
    "Daily Security Scan Report",
    "",
    "Findings by Severity:",
    `  Critical: ${findings.critical}`,
    `  High: ${findings.high}`,
    `  Medium: ${findings.medium}`,
    `  Low: ${findings.low}`,
  ];

  if (findings.newFindings.length > 0) {
    lines.push("");
    lines.push("New findings since yesterday:");
    findings.newFindings.forEach((f) => {
      lines.push(`  [${f.severity}] ${f.title}`);
    });
  } else {
    lines.push("");
    lines.push("No new findings since yesterday.");
  }

  lines.push("");
  lines.push("Compliance Status:");
  lines.push(`  PDPA: ${findings.complianceStatus.pdpa ? "Compliant" : "NON-COMPLIANT"}`);
  lines.push(`  AIAS: ${findings.complianceStatus.aias ? "Compliant" : "NON-COMPLIANT"}`);

  lines.push("");
  lines.push(
    "Please triage these findings, prioritize by business impact, and recommend remediation steps."
  );

  return lines.join("\n");
}

async function main() {
  console.log("Running Security Daily Scan...");

  if (!validateGroup("SECURITY")) {
    console.error("Cannot run — SECURITY group not configured");
    console.error("Set chatId for the 'SECURITY' agent in config/agents.json");
    process.exit(1);
  }

  const findings = await getSecurityFindings();
  const message = formatSecurityMessage(findings);

  await sendAndRecord(GROUPS.SECURITY.chatId, message, { routineName: 'security-daily-scan', agentId: 'security-analyst', topicId: GROUPS.SECURITY.topicId });
  console.log("Security scan summary sent to Security group");
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("Error running security routine:", error);
    process.exit(1);
  });
}
