#!/usr/bin/env bun

/**
 * @routine aws-daily-cost
 * @description Daily AWS cost alert with spend analysis
 * @schedule 0 9 * * *
 * @target AWS Architect group
 */

/**
 * AWS Daily Cost Alert Routine
 *
 * Schedule: 9:00 AM daily
 * Target: AWS Cloud Architect group
 *
 * Gathers AWS cost data and sends it to the AWS Architect group.
 * The AWS agent processes the data with its specialized cost
 * optimization expertise and responds with analysis.
 *
 * Run manually: bun run routines/aws-daily-cost.ts
 */

import { sendAndRecord } from "../src/utils/routineMessage.ts";
import { GROUPS, validateGroup } from "../src/config/groups.ts";

interface CostData {
  yesterday: number;
  weekAverage: number;
  monthToDate: number;
  topServices: Array<{ service: string; cost: number }>;
}

async function getAWSCostData(): Promise<CostData> {
  // TODO: Integrate with AWS Cost Explorer API using AWS SDK
  //
  // Example integration:
  //   import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
  //   const client = new CostExplorerClient({ region: "us-east-1" });
  //   const response = await client.send(new GetCostAndUsageCommand({...}));
  //
  // For now, return placeholder data. The agent still provides useful
  // analysis patterns even with placeholder data during testing.
  return {
    yesterday: 0,
    weekAverage: 0,
    monthToDate: 0,
    topServices: [],
  };
}

function formatCostMessage(data: CostData): string {
  const lines = [
    "Daily AWS Cost Report",
    "",
    `Yesterday's spend: $${data.yesterday.toFixed(2)}`,
    `7-day average: $${data.weekAverage.toFixed(2)}`,
    `Month-to-date: $${data.monthToDate.toFixed(2)}`,
  ];

  if (data.topServices.length > 0) {
    lines.push("");
    lines.push("Top services by cost:");
    data.topServices.forEach((s, i) => {
      lines.push(`${i + 1}. ${s.service}: $${s.cost.toFixed(2)}`);
    });
  }

  lines.push("");
  lines.push(
    "Please analyze for anomalies, compare against recent trends, and suggest cost optimizations."
  );

  return lines.join("\n");
}

async function main() {
  console.log("Running AWS Daily Cost Alert...");

  if (!validateGroup("AWS_ARCHITECT")) {
    console.error("Cannot run — AWS_ARCHITECT group not configured in .env");
    console.error("Set GROUP_AWS_CHAT_ID in your .env file");
    process.exit(1);
  }

  const costData = await getAWSCostData();
  const message = formatCostMessage(costData);

  await sendAndRecord(GROUPS.AWS_ARCHITECT, message, { routineName: 'aws-daily-cost', agentId: 'aws-architect' });
  console.log("AWS cost alert sent to AWS Architect group");
}

main().catch((error) => {
  console.error("Error running AWS cost routine:", error);
  process.exit(1);
});
